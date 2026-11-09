import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { auditEventsTable, calendarEventsTable, captureLogTable, db, noiseRulesTable, pool, tasksTable } from "@workspace/db";
import { client, person, project, resetDb, scopeFor } from "./helpers";

process.env.INBOX_API_KEY = "test-inbox-key";
process.env.SESSION_SECRET ??= "test-secret";

const { default: app } = await import("../src/app");
const { listTasksForAi, searchForAi, getToday, purgeOldNoise } = await import("../src/lib/ai-data");

let server: Server;
let base: string;

beforeAll(async () => {
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await pool.end();
});

const auth = { authorization: "Bearer test-inbox-key", "content-type": "application/json" };

async function post(path: string, body: unknown, headers: Record<string, string> = auth) {
  const r = await fetch(`${base}/api/ingest${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function get(path: string) {
  const r = await fetch(`${base}/api/ingest${path}`, { headers: auth });
  return { status: r.status, body: await r.json() };
}

const item = (ref: string, extra: Record<string, unknown> = {}) => ({
  source: "email",
  source_ref: ref,
  title: `Reply to ${ref}`,
  from_name: "Sam",
  from_address: "sam@supplier.test",
  ...extra,
});

describe("the ingest API", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("needs the key", async () => {
    expect((await post("/tasks", { items: [] }, { "content-type": "application/json" })).status).toBe(401);
    expect((await post("/tasks", { items: [] }, { ...auth, authorization: "Bearer wrong" })).status).toBe(401);
    const saved = process.env.INBOX_API_KEY;
    delete process.env.INBOX_API_KEY;
    expect((await post("/tasks", { items: [] })).status).toBe(503);
    process.env.INBOX_API_KEY = saved;
  });

  it("creates one task for a duplicate source + source_ref (criterion 5)", async () => {
    const first = await post("/tasks", { items: [item("msg-1"), item("msg-1")] });
    expect(first.body.results.map((r: { outcome: string }) => r.outcome)).toEqual(["created", "duplicate"]);
    const again = await post("/tasks", { items: [item("msg-1", { title: "Something else" })] });
    expect(again.body.results[0]).toMatchObject({ outcome: "duplicate", task_id: first.body.results[0].task_id });
    // Same ref from a different source is a different item.
    const slack = await post("/tasks", { items: [item("msg-1", { source: "slack" })] });
    expect(slack.body.results[0].outcome).toBe("created");

    const rows = await db.select().from(tasksTable).where(eq(tasksTable.sourceRef, "msg-1"));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "inbox" && r.createdBy === "ingest")).toBe(true);
    const audits = await db.select().from(auditEventsTable).where(eq(auditEventsTable.actor, "ingest"));
    expect(audits.filter((a) => a.action === "create")).toHaveLength(2);
  });

  it("applies noise rules, but never to meeting actions", async () => {
    const [rule] = await db.insert(noiseRulesTable).values({ matchType: "from_domain_equals", matchValue: "supplier.test", source: null }).returning();
    const r = await post("/tasks", { items: [item("n-1"), item("n-2", { source: "meeting" }), item("n-3", { from_address: "x@other.test" })] });
    expect(r.body.results.map((x: { outcome: string }) => x.outcome)).toEqual(["noise", "created", "created"]);
    expect(r.body.results[0].noise_rule_id).toBe(rule.id);
    const [after] = await db.select().from(noiseRulesTable).where(eq(noiseRulesTable.id, rule.id));
    expect(after.hitCount).toBe(1);
  });

  it("hides a confidential item from every AI-facing route from the moment it is created (criterion 12)", async () => {
    const sale = await project("Sale process", { confidential: true });
    const r = await post("/tasks", {
      items: [
        item("c-1", { title: "Board pack for Hendersons", confidential: true }),
        item("c-2", { title: "Hendersons due diligence", project_hint: "Sale process" }),
        item("c-3", { title: "Hendersons parking permit" }),
      ],
    });
    expect(r.body.results.map((x: { outcome: string }) => x.outcome)).toEqual(["created", "created", "created"]);
    expect(r.body.results[0].task_id).toBeUndefined();
    expect(r.body.results[1].task_id).toBeUndefined();
    expect(r.body.results[2].task_id).toBeTruthy();

    const [hinted] = await db.select().from(tasksTable).where(eq(tasksTable.sourceRef, "c-2"));
    expect(hinted.projectId).toBe(sale.id);

    const open = await get("/open-tasks");
    expect(open.body.tasks.map((t: { title: string }) => t.title)).toEqual(["Hendersons parking permit"]);

    const claude = await scopeFor(await client("Claude"));
    expect((await listTasksForAi(claude, {})).tasks.map((t) => t.title)).toEqual(["Hendersons parking permit"]);
    expect((await searchForAi(claude, { query: "Hendersons" })).results.map((t) => t.title)).toEqual(["Hendersons parking permit"]);
    expect((await getToday(claude)).inbox_count).toBe(1);
  });

  it("records sweeps, keeps the cursor on the last clean run, and clears Noise older than 90 days", async () => {
    expect((await get("/cursor")).body).toEqual({ last_finished_at: null });
    const s1 = await post("/sweep-run", { action: "start" });
    await post("/sweep-run", { action: "finish", id: s1.body.id, items_created: 3, finished_at: "2026-11-09T07:05:00.000Z" });
    const s2 = await post("/sweep-run", { action: "start" });
    await post("/sweep-run", { action: "finish", id: s2.body.id, errors: ["Gmail timed out"], finished_at: "2026-11-09T08:05:00.000Z" });
    expect((await get("/cursor")).body.last_finished_at).toBe("2026-11-09T07:05:00.000Z");

    await post("/tasks", { items: [item("old-noise"), item("new-noise")] });
    await db.update(tasksTable).set({ status: "noise" });
    await db.execute(sql`update tasks set updated_at = now() - interval '91 days' where source_ref = 'old-noise'`);
    expect(await purgeOldNoise(null)).toBe(1);
    const left = await db.select({ ref: tasksTable.sourceRef }).from(tasksTable);
    expect(left.map((t) => t.ref)).toEqual(["new-noise"]);
    // The capture log keeps the ref, so the purged item is still a duplicate if it comes again.
    const again = await post("/tasks", { items: [item("old-noise")] });
    expect(again.body.results[0].outcome).toBe("duplicate");
    expect((await db.select().from(captureLogTable)).length).toBe(2);
  });

  it("replaces the calendar window and logs activity once per source_ref", async () => {
    const sam = await person("Sam Hart");
    const soon = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const end = new Date(soon.getTime() + 30 * 60 * 1000);
    const ev = (ref: string, title: string) => ({ source_ref: ref, title, starts_at: soon.toISOString(), ends_at: end.toISOString(), people: ["Sam Hart", "Nobody Known"] });
    await post("/calendar", { events: [ev("e1", "Old"), ev("e2", "Gone")] });
    const r = await post("/calendar", { events: [ev("e1", "Site visit")] });
    expect(r.body).toMatchObject({ replaced: 1, unmatched_people: ["Nobody Known"] });
    const events = await db.select().from(calendarEventsTable);
    expect(events.map((e) => [e.title, e.personIds])).toEqual([["Site visit", [sam.id]]]);

    const entry = { kind: "email", summary: "Sam sent the oven quote", occurred_at: "2026-11-08T10:00:00Z", source_ref: "a-1", people: ["Sam Hart"] };
    const a1 = await post("/activity", { entries: [entry, entry] });
    expect(a1.body.results.map((x: { outcome: string }) => x.outcome)).toEqual(["created", "duplicate"]);
  });
});
