/** Messaging a colleague on Slack from a task. */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditEventsTable, db, organisationsTable, peopleTable, tasksTable } from "@workspace/db";
import { api, useServer } from "./harness";
import { organisation, person } from "./helpers";

let calls: { path: string; body: Record<string, unknown> }[] = [];
let postReply: Record<string, unknown> = { ok: true, ts: "1731400000.000100" };
vi.mock("../src/services/connectors/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/http")>()),
  proxyWriteJson: async (_c: string, _n: string, _m: string, path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    if (path === "/api/conversations.open") return { ok: true, channel: { id: "D123" } };
    return postReply;
  },
}));

useServer();

async function setup() {
  const kurt = await person("Kurt Mills");
  await db.update(peopleTable).set({ slackUserId: "U_KURT" }).where(eq(peopleTable.id, kurt.id));
  const client = await organisation("ETS");
  const sam = await person("Sam Lee", { organisationId: client.id });
  await db.update(peopleTable).set({ slackUserId: "U_SAM" }).where(eq(peopleTable.id, sam.id));
  const [t] = await db.insert(tasksTable).values({ title: "Reply to ETS on eng-to-eng follow-up call", status: "now", createdBy: "ollie", personId: kurt.id }).returning();
  return { kurt, sam, task: t };
}

describe("message a colleague on Slack from a task", () => {
  it("offers only colleagues with Slack, never people at outside organisations", async () => {
    const { kurt, task } = await setup();
    const res = await api(`tasks/${task.id}/slack-dm`);
    expect(res.body).toEqual({ people: [{ id: kurt.id, name: "Kurt Mills", role: null }], suggestedPersonId: kurt.id });
  });

  it("sends the DM as Ollie, then the task waits on that person with a note", async () => {
    const { kurt, task } = await setup();
    calls = [];
    const res = await api(`tasks/${task.id}/slack-dm`, { method: "POST", body: { personId: kurt.id, text: "Do you want to schedule this?" } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ personId: kurt.id, personName: "Kurt Mills", channel: "D123", ts: "1731400000.000100" });
    expect(calls).toEqual([
      { path: "/api/conversations.open", body: { users: "U_KURT" } },
      { path: "/api/chat.postMessage", body: { channel: "D123", text: "Do you want to schedule this?" } },
    ]);
    const [t] = await db.select().from(tasksTable).where(eq(tasksTable.id, task.id));
    expect(t).toMatchObject({ status: "waiting", waitingOnPersonId: kurt.id });
    expect(t.notes).toContain('Messaged Kurt Mills on Slack');
    expect(t.notes).toContain('"Do you want to schedule this?"');
    const [audit] = await db.select().from(auditEventsTable).where(eq(auditEventsTable.action, "slack_dm"));
    expect(audit).toMatchObject({ entityType: "task", entityId: task.id });
  });

  it("refuses someone outside, and changes nothing when Slack refuses", async () => {
    const { sam, kurt, task } = await setup();
    calls = [];
    expect((await api(`tasks/${task.id}/slack-dm`, { method: "POST", body: { personId: sam.id, text: "Hi" } })).status).toBe(400);
    expect(calls).toHaveLength(0);
    postReply = { ok: false, error: "missing_scope" };
    const res = await api(`tasks/${task.id}/slack-dm`, { method: "POST", body: { personId: kurt.id, text: "Hi" } });
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("permission to write messages");
    const [t] = await db.select().from(tasksTable).where(eq(tasksTable.id, task.id));
    expect(t.status).toBe("now");
    postReply = { ok: true, ts: "1" };
    // An internal organisation counts as colleagues.
    await db.update(organisationsTable).set({ internal: true }).where(eq(organisationsTable.name, "ETS"));
    expect((await api(`tasks/${task.id}/slack-dm`)).body.people).toHaveLength(2);
  });
});
