import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { accessRequestsTable, auditEventsTable, db, pool, projectsTable, tasksTable } from "@workspace/db";
import { searchItems } from "../src/lib/ai-data/search";
import { loadVisibleDocs, retrieveForAsk } from "../src/lib/ai-data/retrieve";
import { recordReads, visibleRefs, type AiScope } from "../src/lib/ai-data/scope";
import { REQUEST_REPLY, requestAccess } from "../src/lib/ai-data/requests";
import { approveRequest, declineRequest, endAccess, listAccessRequests, listAiActivity } from "../src/services/access";
import { client, decision, fact, link, note, organisation, person, project, resetDb, scopeFor, task } from "./helpers";

afterAll(async () => {
  await pool.end();
});

/** Everything an AI-facing read can return for a query, as refs. */
async function aiSees(scope: AiScope, q: string): Promise<string[]> {
  const hits = await searchItems({ q, mode: "ask", visibleOnly: true, scope, limitPerType: 50 });
  return hits.map((h) => `${h.type}:${h.id}`);
}

async function docsText(scope: AiScope, refs: string[]): Promise<string> {
  return (await loadVisibleDocs(scope, refs)).map((d) => d.text).join("\n");
}

describe("confidential projects (criterion 2)", () => {
  beforeEach(resetDb);

  it("hides the project and everything under it from search, retrieval and loading", async () => {
    const claude = await scopeFor(await client("Claude"));
    const sale = await project("Sale process", { confidential: true, summary: "Selling the bakery to Hendersons" });
    const open = await project("Garden shed", { summary: "Building the bakery shed" });
    const t1 = await task("Send bakery valuation to Hendersons", { projectId: sale.id });
    const t2 = await task("Order bakery shed timber", { projectId: open.id });
    const d1 = await decision(sale.id, "Accept the bakery offer from Hendersons");
    const n1 = await note("project", sale.id, "Hendersons bakery offer notes");
    const f1 = await fact("project", sale.id, "Bakery asking price is 2 million");
    const linked = await task("Bakery lawyer call");
    await link("task", linked.id, "project", sale.id);

    const seen = await aiSees(claude, "bakery hendersons");
    expect(seen).toContain(`task:${t2.id}`);
    expect(seen).toContain(`project:${open.id}`);
    for (const hidden of [`project:${sale.id}`, `task:${t1.id}`, `decision:${d1.id}`, `note:${n1.id}`, `fact:${f1.id}`, `task:${linked.id}`]) {
      expect(seen).not.toContain(hidden);
    }

    const all = [`project:${sale.id}`, `task:${t1.id}`, `decision:${d1.id}`, `note:${n1.id}`, `fact:${f1.id}`, `task:${linked.id}`, `task:${t2.id}`];
    const visible = await visibleRefs(claude, all);
    expect([...visible]).toEqual([`task:${t2.id}`]);
    const text = await docsText(claude, all);
    expect(text).not.toMatch(/Sale process|Hendersons|2 million/);

    const r = await retrieveForAsk(claude, "What is happening with the bakery sale to Hendersons?");
    expect(r.docs.map((d) => d.ref)).not.toContain(`project:${sale.id}`);
    expect(r.docs.map((d) => d.text).join("\n")).not.toMatch(/Sale process|Hendersons|2 million/);
    expect(r.hiddenMatches).toBe(true);
    expect(r.hiddenRefs).toContain(`project:${sale.id}`);
  });

  it("does not count hidden rows: the search returns no trace of them", async () => {
    const claude = await scopeFor(await client("Claude"));
    const sale = await project("Sale process", { confidential: true });
    for (let i = 0; i < 5; i++) await task(`Secret bakery step ${i}`, { projectId: sale.id });
    const hits = await searchItems({ q: "secret bakery", mode: "ask", visibleOnly: true, scope: claude, limitPerType: 50 });
    expect(hits).toHaveLength(0);
  });

  it("hides AI-access-off projects the same way, and switching back restores them", async () => {
    const claude = await scopeFor(await client("Claude"));
    const p = await project("Quiet thing", { aiAccess: false });
    const t = await task("Quiet bakery errand", { projectId: p.id });
    expect(await aiSees(claude, "quiet bakery errand")).not.toContain(`task:${t.id}`);
    await db.update(projectsTable).set({ aiAccess: true }).where(eq(projectsTable.id, p.id));
    expect(await aiSees(claude, "quiet bakery errand")).toContain(`task:${t.id}`);
  });

  it("hides an item inserted under a confidential project at once", async () => {
    const claude = await scopeFor(await client("Claude"));
    const sale = await project("Sale process", { confidential: true });
    const before = await aiSees(claude, "brand new bakery item");
    expect(before).toHaveLength(0);
    const t = await task("Brand new bakery item", { projectId: sale.id });
    const own = await task("Brand new bakery item, own flag", { confidential: true });
    const seen = await aiSees(claude, "brand new bakery item");
    expect(seen).not.toContain(`task:${t.id}`);
    expect(seen).not.toContain(`task:${own.id}`);
  });

  it("lets an item override its parent to readable, without leaking the parent's name", async () => {
    const claude = await scopeFor(await client("Claude"));
    const sale = await project("Sale process", { confidential: true });
    const t = await task("Book the bakery photographer", { projectId: sale.id, confidential: false });
    const d = await decision(sale.id, "Use the bakery photographer", false);
    const seen = await aiSees(claude, "bakery photographer");
    expect(seen).toContain(`task:${t.id}`);
    expect(seen).toContain(`decision:${d.id}`);
    const text = await docsText(claude, [`task:${t.id}`, `decision:${d.id}`]);
    expect(text).toContain("Book the bakery photographer");
    expect(text).not.toContain("Sale process");
    const hits = await searchItems({ q: "bakery photographer", mode: "ask", visibleOnly: true, scope: claude });
    expect(hits.find((h) => h.type === "decision")?.snippet ?? null).toBeNull();
  });

  it("hides a task linked only to hidden people, but not one with a visible person", async () => {
    const claude = await scopeFor(await client("Claude"));
    const secret = await person("Agnes Hidden", { confidential: true });
    const open = await person("Bob Open");
    const onlyHidden = await task("Bakery chat with Agnes", { personId: secret.id });
    const withOpen = await task("Bakery chat with Bob", { personId: open.id });
    const seen = await aiSees(claude, "bakery chat");
    expect(seen).not.toContain(`task:${onlyHidden.id}`);
    expect(seen).toContain(`task:${withOpen.id}`);
  });

  it("never names a hidden organisation in a visible person's snippet", async () => {
    const claude = await scopeFor(await client("Claude"));
    const org = await organisation("Hendersons Holdings", { confidential: true });
    const p = await person("Carol Visible", { organisationId: org.id, role: "Buyer" });
    const hits = await searchItems({ q: "carol", mode: "ask", visibleOnly: true, scope: claude });
    const hit = hits.find((h) => h.type === "person" && h.id === p.id);
    expect(hit?.snippet).toBe("Buyer");
    expect(await docsText(claude, [`person:${p.id}`])).not.toContain("Hendersons");
  });
});

describe("access requests and grants (criteria 3 and 10)", () => {
  beforeEach(resetDb);

  it("gives the same reply whether or not the item exists, and stores both for Ollie", async () => {
    const c = await client("Claude");
    const claude = await scopeFor(c);
    const sale = await project("Sale process", { confidential: true });
    expect(await requestAccess(claude, "Sale process", "Drafting the board update")).toEqual(REQUEST_REPLY);
    expect(await requestAccess(claude, "Project Unicorn", null)).toEqual(REQUEST_REPLY);
    // Asking again does not add a second request.
    expect(await requestAccess(claude, "sale-process", "Again")).toEqual(REQUEST_REPLY);

    const { pending } = await listAccessRequests();
    expect(pending).toHaveLength(2);
    const matched = pending.find((r) => r.item);
    const unmatched = pending.find((r) => !r.item);
    expect(matched?.item?.ref).toBe(`project:${sale.id}`);
    expect(unmatched?.requestedName).toBe("Project Unicorn");

    const audits = await db.select().from(auditEventsTable).where(eq(auditEventsTable.action, "request_access"));
    expect(audits).toHaveLength(3);
    expect(audits.every((a) => a.actor === "Claude" && a.clientId === c.id)).toBe(true);
  });

  it("an approval opens the item and its children to that client only, for one hour", async () => {
    const claudeClient = await client("Claude");
    const sweepClient = await client("Capture sweep");
    const sale = await project("Sale process", { confidential: true, summary: "Selling the bakery" });
    const child = await task("Bakery valuation", { projectId: sale.id });
    const ownConfidential = await decision(sale.id, "Bakery price floor", true);

    await requestAccess(await scopeFor(claudeClient), "Sale process", "Board update");
    const [req] = (await listAccessRequests()).pending;
    const approved = await approveRequest(req.id);
    expect(approved.status).toBe("approved");
    const minutes = (new Date(approved.expiresAt!).getTime() - Date.now()) / 60000;
    expect(minutes).toBeGreaterThan(59);
    expect(minutes).toBeLessThanOrEqual(60);

    const claude = await scopeFor(claudeClient);
    const sweep = await scopeFor(sweepClient);
    const refs = [`project:${sale.id}`, `task:${child.id}`, `decision:${ownConfidential.id}`];
    expect([...(await visibleRefs(claude, refs))].sort()).toEqual([`project:${sale.id}`, `task:${child.id}`].sort());
    expect((await visibleRefs(sweep, refs)).size).toBe(0);
    expect(await aiSees(claude, "bakery")).toContain(`task:${child.id}`);
    expect(await aiSees(sweep, "bakery")).toHaveLength(0);

    // After the hour, the grant lapses without anything being scheduled.
    await db.update(accessRequestsTable).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(accessRequestsTable.id, req.id));
    expect((await visibleRefs(await scopeFor(claudeClient), refs)).size).toBe(0);
  });

  it("an item's own grant unlocks it even with its own confidential flag", async () => {
    const c = await client("Claude");
    const sale = await project("Sale process");
    const d = await decision(sale.id, "Bakery price floor", true);
    await requestAccess(await scopeFor(c), `decision:${d.id}`, null);
    const [req] = (await listAccessRequests()).pending;
    await approveRequest(req.id);
    expect((await visibleRefs(await scopeFor(c), [`decision:${d.id}`])).size).toBe(1);
  });

  it("ending early and declining both leave the item hidden", async () => {
    const c = await client("Claude");
    const sale = await project("Sale process", { confidential: true });
    await requestAccess(await scopeFor(c), "Sale process", null);
    const [req] = (await listAccessRequests()).pending;
    await approveRequest(req.id);
    expect((await visibleRefs(await scopeFor(c), [`project:${sale.id}`])).size).toBe(1);
    await endAccess(req.id);
    expect((await visibleRefs(await scopeFor(c), [`project:${sale.id}`])).size).toBe(0);

    await requestAccess(await scopeFor(c), "Sale process", null);
    const [again] = (await listAccessRequests()).pending;
    await declineRequest(again.id);
    expect((await visibleRefs(await scopeFor(c), [`project:${sale.id}`])).size).toBe(0);

    const actions = (await db.select().from(auditEventsTable)).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["approve_access", "end_access", "decline_access"]));
  });

  it("an unmatched request needs Ollie to choose the item before it can be allowed", async () => {
    const c = await client("Claude");
    const sale = await project("Sale process", { confidential: true });
    await requestAccess(await scopeFor(c), "the house sale", null);
    const [req] = (await listAccessRequests()).pending;
    await expect(approveRequest(req.id)).rejects.toThrow(/Choose which item/);
    await approveRequest(req.id, { entityType: "project", entityId: sale.id });
    expect((await visibleRefs(await scopeFor(c), [`project:${sale.id}`])).size).toBe(1);
  });
});

describe("AI read log (criterion 6, reads)", () => {
  beforeEach(resetDb);

  it("writes one audit row per item given to an AI, grouped as one action in the log", async () => {
    const c = await client("Claude");
    const scope = await scopeFor(c);
    const p = await project("Garden shed");
    const t = await task("Order timber", { projectId: p.id });
    await recordReads(scope, [`project:${p.id}`, `task:${t.id}`, `task:${t.id}`], { via: "test", question: "What about the shed?" });

    const rows = await db.select().from(auditEventsTable).where(and(eq(auditEventsTable.action, "read"), eq(auditEventsTable.clientId, c.id)));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.actor === "Claude")).toBe(true);
    expect(new Set(rows.map((r) => (r.payload as { batch: string }).batch)).size).toBe(1);

    const log = await listAiActivity();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actor: "Claude", kind: "read", count: 2, context: "What about the shed?" });
    expect(log[0].items.map((i) => i.name).sort()).toEqual(["Garden shed", "Order timber"]);
  });

  it("keeps Ollie's own approvals out of the AI log", async () => {
    const c = await client("Claude");
    await project("Sale process", { confidential: true });
    await requestAccess(await scopeFor(c), "Sale process", null);
    const [req] = (await listAccessRequests()).pending;
    await approveRequest(req.id);
    const log = await listAiActivity();
    expect(log.map((l) => l.kind)).toEqual(["request"]);
  });

  it("records the task row's own flag so lists can show it hidden", async () => {
    const sale = await project("Sale process", { confidential: true });
    const t = await task("Bakery valuation", { projectId: sale.id });
    const { toTaskView } = await import("../src/services/taskView");
    const [row] = await db.select().from(tasksTable).where(eq(tasksTable.id, t.id));
    expect((await toTaskView(row)).hiddenFromAi).toBe(true);
  });
});
