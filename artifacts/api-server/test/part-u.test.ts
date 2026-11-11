/**
 * Part U (build plan section 20): tasks that close themselves from their own conversation, and
 * "Looks done" from anywhere else.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, peopleTable, taskEvidenceTable, tasksTable } from "@workspace/db";
import { todayLondon } from "@workspace/shared";
import { mapGmailMessage, type GmailRead } from "../src/services/connectors/gmail";
import type { SlackRead } from "../src/services/connectors/slack";
import type { SortContext, SortedUnit } from "../src/services/connectors/sorter";
import type { WorkUnit } from "../src/services/connectors/messages";
import { buildDigest } from "../src/services/digest";
import { api, useServer } from "./harness";
import { person } from "./helpers";

let nextSlack: SlackRead = emptySlack();
let nextGmail: GmailRead = { account: "ollie@example.com", units: [], found: 0, leftOut: 0, newest: null, more: false };
/** The fake sorter: answers per unit index, and remembers what open items each unit was given. */
let answer: (u: WorkUnit, i: number) => Partial<SortedUnit> = () => ({});
let offered: (string | null)[] = [];

function emptySlack(): SlackRead {
  return { account: "ollie at Example", me: "UME", opened: [], units: [], found: 0, leftOut: 0, checked: 0, state: { since: new Date().toISOString(), convs: {} } };
}

vi.mock("../src/services/connectors/slack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/slack")>()),
  readSlack: async () => nextSlack,
  repliedInThread: async () => false,
}));
vi.mock("../src/services/connectors/gmail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/gmail")>()),
  readGmail: async () => nextGmail,
}));
vi.mock("../src/services/connectors/noReply", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/noReply")>()),
  refreshNoReply: async () => null,
}));
vi.mock("../src/services/connectors/sorter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/sorter")>()),
  sortUnits: async (units: WorkUnit[], ctx: SortContext) => {
    offered = units.map((_, i) => ctx.openItems?.(i) ?? null);
    return units.map((u, i) => ({ summary: "", project: "", items: [], ...answer(u, i) }));
  },
}));
vi.mock("../src/services/connectors/googleCalendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/googleCalendar")>()),
  readGoogleCalendar: async () => ({ account: null, events: [], found: 0, skipped: 0 }),
}));
vi.mock("../src/services/ask/model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/ask/model")>()),
  digestSummaryFromLines: async () => "Summary.",
}));

useServer();

const HOUR = 3600_000;
const tsOf = (d: Date) => (d.getTime() / 1000).toFixed(6);

function slackUnit(conv: string, msgs: { at: Date; fromMe?: boolean; text: string }[]): WorkUnit {
  const messages = msgs.map((m) => ({
    ref: `slack:${conv}:${tsOf(m.at)}`,
    at: m.at,
    fromMe: !!m.fromMe,
    fromName: m.fromMe ? null : "Sam Lee",
    fromAddress: m.fromMe ? null : "sam@client.com",
    fromSlackId: m.fromMe ? "UME" : "USAM",
    text: m.text,
    url: `https://x.slack.com/archives/${conv}/p${tsOf(m.at).replace(".", "")}`,
  }));
  return { source: "slack", key: messages[messages.length - 1].ref, subject: null, channel: "Sam Lee", people: [{ name: "Sam Lee", email: "sam@client.com", slackId: "USAM" }], messages, conversation: { id: conv, kind: "im" } };
}

async function slackCheck(units: WorkUnit[]) {
  nextSlack = { ...emptySlack(), units, found: units.length };
  const r = await api("connectors/slack/check", { method: "POST" });
  expect(r.body).toMatchObject({ ok: true });
  return r.body.counts as Record<string, number>;
}

async function sam() {
  const p = await person("Sam Lee");
  await db.update(peopleTable).set({ slackUserId: "USAM", email: "sam@client.com" }).where(eq(peopleTable.id, p.id));
  return p;
}

async function task(o: Partial<typeof tasksTable.$inferInsert>) {
  const [t] = await db
    .insert(tasksTable)
    .values({ title: "Sign the contract for Sam", status: "now", source: "slack", createdBy: "ollieos", capturedAt: new Date(Date.now() - 5 * HOUR), ...o })
    .returning();
  return t;
}

const done = (t: { id: number }, ref: string, quote = "Done, signed and sent back.") => ({ progress: [{ item: `task:${t.id}`, shows: "done", ref, quote }] });

describe("tasks that close themselves", () => {
  it("closes a Slack task when Ollie says it is done in the same conversation, and the digest says how", async () => {
    const p = await sam();
    const asked = new Date(Date.now() - 5 * HOUR);
    const t = await task({ sourceRef: `slack:D1:${tsOf(asked)}`, personId: p.id, capturedAt: asked });
    const replied = new Date(Date.now() - HOUR);
    const reply = slackUnit("D1", [{ at: replied, fromMe: true, text: "Done, signed and sent back." }]);
    answer = () => done(t, reply.messages[0].ref);
    const counts = await slackCheck([reply]);
    expect(offered[0]).toContain(`[task:${t.id}] from this conversation, task for Sam Lee: Sign the contract for Sam`);
    expect(counts.closed).toBe(1);
    const [after] = await db.select().from(tasksTable).where(eq(tasksTable.id, t.id));
    expect(after.status).toBe("done");
    const [ev] = await db.select().from(taskEvidenceTable);
    expect(ev).toMatchObject({ taskId: t.id, source: "slack", saidBy: "You", place: "Slack, Sam Lee", shows: "done", strength: "same", applied: true, quote: "Done, signed and sent back." });
    const list = (await api(`tasks/${t.id}/evidence`)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ applied: true, dismissed: false });

    const digest = await buildDigest(todayLondon());
    expect(digest.sections.moved!.items.map((i) => i.text)).toContain("Done (you told Sam on Slack): Sign the contract for Sam");
  });

  it("leaves the task open when nothing shows it is done, and never uses the message it came from", async () => {
    const p = await sam();
    const asked = new Date(Date.now() - 5 * HOUR);
    const t = await task({ sourceRef: `slack:D2:${tsOf(asked)}`, personId: p.id, capturedAt: asked });
    // "Will do tomorrow": the sorter reports nothing.
    answer = () => ({ progress: [] });
    await slackCheck([slackUnit("D2", [{ at: new Date(Date.now() - HOUR), fromMe: true, text: "Will do tomorrow." }])]);
    // A claim pointing at the original request is ignored.
    const original = slackUnit("D2", [{ at: asked, text: "Can you sign the contract?" }]);
    answer = () => done(t, original.messages[0].ref);
    await slackCheck([original]);
    const [after] = await db.select().from(tasksTable).where(eq(tasksTable.id, t.id));
    expect(after.status).toBe("now");
    expect(await db.select().from(taskEvidenceTable)).toHaveLength(0);
  });

  it("closes a Waiting on task when the other person delivers in the same conversation", async () => {
    const p = await sam();
    const t = await task({ title: "Sam to send the signed contract", status: "waiting", waitingOnPersonId: p.id, sourceRef: `slack:D3:${tsOf(new Date(Date.now() - 5 * HOUR))}` });
    const delivered = slackUnit("D3", [{ at: new Date(Date.now() - HOUR), text: "Signed copy attached." }]);
    answer = () => done(t, delivered.messages[0].ref, "Signed copy attached.");
    await slackCheck([delivered]);
    expect(offered[0]).toContain(`[task:${t.id}] from this conversation, waiting on Sam Lee`);
    const [after] = await db.select().from(tasksTable).where(eq(tasksTable.id, t.id));
    expect(after.status).toBe("done");
  });

  it("only marks Looks done from another conversation, or when the wrong side says done", async () => {
    const p = await sam();
    const elsewhere = await task({ sourceRef: "slack:D4:1.000000", personId: p.id });
    const own = await task({ title: "Review the plan", sourceRef: `slack:D5:${tsOf(new Date(Date.now() - 5 * HOUR))}`, personId: p.id });
    const other = slackUnit("D9", [{ at: new Date(Date.now() - HOUR), fromMe: true, text: "Contract is signed." }]);
    // In its own conversation, but Sam (not Ollie) says a task of Ollie's is done.
    const samSays = slackUnit("D5", [{ at: new Date(Date.now() - HOUR), text: "I think the plan review is done." }]);
    answer = (u) => (u.conversation!.id === "D9" ? done(elsewhere, other.messages[0].ref, "Contract is signed.") : done(own, samSays.messages[0].ref, "I think the plan review is done."));
    const counts = await slackCheck([other, samSays]);
    expect(offered[0]).toContain(`[task:${elsewhere.id}] from elsewhere, task for Sam Lee`);
    expect(counts.looks_done).toBe(2);
    for (const id of [elsewhere.id, own.id]) {
      const [row] = await db.select().from(tasksTable).where(eq(tasksTable.id, id));
      expect(row.status).toBe("now");
    }
    const view = (await api(`tasks/${elsewhere.id}`)).body.task;
    expect(view.looksDone).toBe("You (Slack, Sam Lee): Contract is signed.");

    // Not done: the marker goes and stays gone.
    const [ev] = await db.select().from(taskEvidenceTable).where(eq(taskEvidenceTable.taskId, elsewhere.id));
    const dismissed = await api(`tasks/${elsewhere.id}/evidence/${ev.id}/dismiss`, { method: "POST" });
    expect(dismissed.body[0]).toMatchObject({ dismissed: true });
    expect((await api(`tasks/${elsewhere.id}`)).body.task.looksDone).toBeNull();
    // Mark done from the other marker works like any status change.
    expect((await api(`tasks/${own.id}`, { method: "PATCH", body: { status: "done" } })).status).toBe(200);
    expect((await api(`tasks/${own.id}`)).body.task.looksDone).toBeNull();
  });

  it("keeps a reopened task open, and never offers a task hidden from AI", async () => {
    const p = await sam();
    const asked = new Date(Date.now() - 5 * HOUR);
    const t = await task({ sourceRef: `slack:D6:${tsOf(asked)}`, personId: p.id, capturedAt: asked });
    const secret = await task({ title: "Agree the bonus", sourceRef: `slack:D6:${tsOf(new Date(asked.getTime() + 1000))}`, personId: p.id, confidential: true });
    const reply = slackUnit("D6", [{ at: new Date(Date.now() - HOUR), fromMe: true, text: "Done." }]);
    answer = () => ({ progress: [...done(t, reply.messages[0].ref).progress, ...done(secret, reply.messages[0].ref).progress] });
    await slackCheck([reply]);
    expect(offered[0]).not.toContain(`task:${secret.id}`);
    const [s] = await db.select().from(tasksTable).where(eq(tasksTable.id, secret.id));
    expect(s.status).toBe("now");

    // Ollie reopens it; the same message read again does not close it.
    await api(`tasks/${t.id}`, { method: "PATCH", body: { status: "now" } });
    await slackCheck([reply]);
    const [after] = await db.select().from(tasksTable).where(eq(tasksTable.id, t.id));
    expect(after.status).toBe("now");
  });

  it("reads a signing confirmation email only as evidence: Looks done, no new task", async () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64url");
    const confirmation = mapGmailMessage(
      {
        id: "m9",
        threadId: "t9",
        labelIds: ["INBOX"],
        internalDate: String(Date.now() - HOUR),
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: "DocuSign <dse@eumail.docusign.net>" },
            { name: "Subject", value: "Completed: Please sign the Springfield contract" },
            { name: "Auto-Submitted", value: "auto-generated" },
          ],
          body: { data: b64("All parties have completed the envelope.") },
        },
      } as never,
      "ollie@example.com",
    );
    expect(confirmation.skipped).toBeUndefined();
    expect(confirmation.unit).toMatchObject({ confirmation: true, conversation: { id: "t9", kind: "thread" } });
    // An ordinary automated email is still left out.
    const other = mapGmailMessage({ id: "m8", threadId: "t8", labelIds: ["INBOX"], internalDate: "0", payload: { mimeType: "text/plain", headers: [{ name: "From", value: "noreply@shop.com" }, { name: "Subject", value: "Order completed" }], body: { data: b64("Thanks") } } } as never, "ollie@example.com");
    expect(other.skipped).toBe("automated");

    const t = await task({ source: "slack", sourceRef: "slack:D7:1.000000" });
    nextGmail = { account: "ollie@example.com", units: [confirmation.unit!], found: 1, leftOut: 0, newest: new Date(), more: false };
    answer = () => ({
      ...done(t, "gmail:m9", "All parties have completed the envelope."),
      // Even if the sorter offers an item, a confirmation makes no task.
      items: [{ ref: "gmail:m9", type: "task", title: "File the contract", action: "", priority: "low", due: "", project: "", person: "", quote: "", confidential: false }],
    });
    const before = (await db.select().from(tasksTable)).length;
    const r = await api("connectors/gmail/check", { method: "POST" });
    expect(r.body).toMatchObject({ ok: true });
    expect(offered[0]).toContain(`[task:${t.id}] from elsewhere`);
    expect((await db.select().from(tasksTable)).length).toBe(before);
    const view = (await api(`tasks/${t.id}`)).body.task;
    expect(view.status).toBe("now");
    expect(view.looksDone).toBe("DocuSign (Email: Completed: Please sign the Springfield contract): All parties have completed the envelope.");
  });
});
