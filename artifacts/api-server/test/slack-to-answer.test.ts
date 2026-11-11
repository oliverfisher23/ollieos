/**
 * Part P (build plan section 19): Slack to answer. The Slack check keeps a row per conversation whose
 * newest message is from someone else; Ollie's reply closes it; Done hides it until a newer message.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditEventsTable, db, peopleTable, slackToAnswerTable, tasksTable } from "@workspace/db";
import type { SlackRead } from "../src/services/connectors/slack";
import { cleanReply, type SortedUnit } from "../src/services/connectors/sorter";
import type { WorkUnit } from "../src/services/connectors/messages";
import { oneWorkingDayBefore, slackRepliesOverdue } from "../src/services/slackToAnswer";
import { api, useServer } from "./harness";
import { person } from "./helpers";

const emptyRead = (): SlackRead => ({ account: "ollie at Example", me: "UME", opened: [], units: [], found: 0, leftOut: 0, checked: 0, state: { since: new Date().toISOString(), convs: {} } });
let nextSlack: SlackRead = emptyRead();
let nextSorted: SortedUnit[] = [];
let threadReplied = new Set<string>();
let threadLooks: string[] = [];
let drafts: { to: string; messages: unknown[] }[] = [];

vi.mock("../src/services/connectors/slack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/slack")>()),
  readSlack: async () => nextSlack,
  repliedInThread: async (conv: string, ts: string) => {
    threadLooks.push(`${conv}:${ts}`);
    return threadReplied.has(`${conv}:${ts}`);
  },
  recentSlackMessages: async () => [
    { fromMe: false, fromName: "Sam Lee", at: new Date(), text: "Can you send the pilot numbers by Friday?" },
  ],
}));
vi.mock("../src/services/connectors/sorter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/sorter")>()),
  sortUnits: async (units: WorkUnit[]) => units.map((_, i) => nextSorted[i] ?? { summary: "", project: "", items: [] }),
}));
vi.mock("../src/services/connectors/googleCalendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/googleCalendar")>()),
  readGoogleCalendar: async () => ({ account: null, events: [], found: 0, skipped: 0 }),
}));
vi.mock("../src/services/ask/model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/ask/model")>()),
  draftSlackReplyFromDocs: async (o: { to: string; messages: unknown[] }) => {
    drafts.push(o);
    return "Hi Sam, I'll send them over by Friday.";
  },
}));

useServer();

const HOUR = 3600_000;
const tsAt = (d: Date) => (d.getTime() / 1000).toFixed(6);

function unit(conv: string, kind: "im" | "mpim" | "channel", msgs: { at: Date; fromMe?: boolean; who?: string; slackId?: string; text?: string }[], place = "Sam Lee"): WorkUnit {
  const messages = msgs.map((m) => ({
    ref: `slack:${conv}:${tsAt(m.at)}`,
    at: m.at,
    fromMe: !!m.fromMe,
    fromName: m.fromMe ? null : (m.who ?? "Sam Lee"),
    fromAddress: m.fromMe ? null : "sam@client.com",
    fromSlackId: m.fromMe ? "UME" : (m.slackId ?? "USAM"),
    text: m.text ?? "Can you send the pilot numbers by Friday?",
    url: `https://x.slack.com/archives/${conv}/p${tsAt(m.at).replace(".", "")}`,
  }));
  return {
    source: "slack",
    key: messages[messages.length - 1].ref,
    subject: null,
    channel: place,
    people: [{ name: "Sam Lee", email: "sam@client.com", slackId: "USAM" }],
    messages,
    conversation: { id: conv, kind },
  };
}

const reply = (needs: "reply" | "info" | "none", ask: string): SortedUnit => ({ summary: "", project: "", items: [], reply: { needs, ask } });

async function check(read: Partial<SlackRead>, sorted: SortedUnit[] = []) {
  nextSlack = { ...emptyRead(), ...read };
  nextSorted = sorted;
  const r = await api("connectors/slack/check", { method: "POST" });
  expect(r.body).toMatchObject({ ok: true });
  return r;
}

const list = async () => (await api("email/slack")).body as { items: Record<string, any>[]; readBy: string; checkedAt: string | null };

describe("Slack to answer", () => {
  it("lists a DM whose newest message is from someone else, with its ask, and closes it when Ollie replies", async () => {
    threadReplied = new Set();
    const asked = new Date(Date.now() - 2 * HOUR);
    await check({ units: [unit("D1", "im", [{ at: asked }])], opened: [{ id: "D1", kind: "im", mineTs: null }] }, [reply("reply", "Wants the pilot numbers by Friday")]);
    let l = await list();
    expect(l.readBy).toBe("ollieos");
    expect(l.checkedAt).not.toBeNull();
    expect(l.items).toHaveLength(1);
    expect(l.items[0]).toMatchObject({ kind: "im", place: "Sam Lee", fromName: "Sam Lee", needs: "reply", ask: "Wants the pilot numbers by Friday", hidden: false, taskId: null });

    // Ollie answers in the DM: the next check sees his message and the row closes.
    const answered = new Date(Date.now() - HOUR);
    await check({ units: [unit("D1", "im", [{ at: answered, fromMe: true, text: "Will do" }])], opened: [{ id: "D1", kind: "im", mineTs: tsAt(answered) }] });
    l = await list();
    expect(l.items).toHaveLength(0);
    const [row] = await db.select().from(slackToAnswerTable);
    expect(row.closedAt).not.toBeNull();

    // They write again: back on the list with the new message.
    const again = new Date(Date.now() - 10 * 60_000);
    await check({ units: [unit("D1", "im", [{ at: again, text: "Thanks! One more thing?" }])], opened: [{ id: "D1", kind: "im", mineTs: null }] }, [reply("info", "Says thanks")]);
    l = await list();
    expect(l.items).toHaveLength(1);
    expect(l.items[0]).toMatchObject({ needs: "info", ask: "Says thanks", text: "Thanks! One more thing?" });
  });

  it("Done hides it until a newer message, and Undo puts it back", async () => {
    const asked = new Date(Date.now() - 3 * HOUR);
    await check({ units: [unit("D2", "im", [{ at: asked }])] }, [reply("reply", "Wants numbers")]);
    const id = (await list()).items[0].id;
    const done = await api(`email/slack/${id}/done`, { method: "POST" });
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ taskId: null, previousStatus: null });
    expect((await list()).items).toHaveLength(0);

    const undo = await api(`email/slack/${id}/undo-done`, { body: done.body });
    expect(undo.status).toBe(204);
    expect((await list()).items).toHaveLength(1);

    await api(`email/slack/${id}/done`, { method: "POST" });
    // The same message read again (a quiet DM looked at later) does not bring it back.
    await check({ units: [unit("D2", "im", [{ at: asked }])] }, [reply("reply", "Wants numbers")]);
    expect((await list()).items).toHaveLength(0);
    // A newer message does.
    await check({ units: [unit("D2", "im", [{ at: new Date(Date.now() - HOUR), text: "Any news?" }])] }, [reply("reply", "Chasing the numbers")]);
    const l = await list();
    expect(l.items).toHaveLength(1);
    expect(l.items[0].ask).toBe("Chasing the numbers");
  });

  it("lists a conversation with someone hidden from AI without reading it, and will not draft it", async () => {
    const sam = await person("Sam Lee", { aiAccess: false });
    await db.update(peopleTable).set({ slackUserId: "USAM" }).where(eq(peopleTable.id, sam.id));
    await check({ units: [unit("D3", "im", [{ at: new Date(Date.now() - HOUR) }])] }, [reply("reply", "Should not be kept")]);
    const [it] = (await list()).items;
    expect(it).toMatchObject({ needs: "unknown", ask: null, hidden: true, personId: sam.id });
    const [row] = await db.select().from(slackToAnswerTable);
    expect(row.ask).toBeNull();
    drafts = [];
    const d = await api(`email/slack/${it.id}/draft`, { method: "POST" });
    expect(d.status).toBe(409);
    expect(drafts).toHaveLength(0);
  });

  it("drafts a reply to copy, and posts nothing", async () => {
    const sam = await person("Sam Lee");
    await db.update(peopleTable).set({ slackUserId: "USAM" }).where(eq(peopleTable.id, sam.id));
    await check({ units: [unit("D4", "im", [{ at: new Date(Date.now() - HOUR) }])] }, [reply("reply", "Wants numbers")]);
    const [it] = (await list()).items;
    drafts = [];
    const d = await api(`email/slack/${it.id}/draft`, { method: "POST" });
    expect(d.status).toBe(200);
    expect(d.body).toEqual({ text: "Hi Sam, I'll send them over by Friday." });
    expect(drafts[0]).toMatchObject({ to: "Sam Lee" });
    expect(drafts[0].messages).toHaveLength(1);
    // Still waiting: drafting changes nothing.
    expect((await list()).items).toHaveLength(1);
    const audit = await db.select().from(auditEventsTable).where(eq(auditEventsTable.action, "draft"));
    expect(audit.some((a) => (a.payload as { via?: string }).via === "slack_to_answer")).toBe(true);
  });

  it("Make a task adds one Now task linked to the message, and Done closes it", async () => {
    await check({ units: [unit("D5", "im", [{ at: new Date(Date.now() - HOUR) }])] }, [reply("reply", "Wants numbers")]);
    const [it] = (await list()).items;
    const a = await api(`email/slack/${it.id}/task`, { method: "POST" });
    expect(a.status).toBe(200);
    const b = await api(`email/slack/${it.id}/task`, { method: "POST" });
    expect(b.body.taskId).toBe(a.body.taskId);
    const [t] = await db.select().from(tasksTable).where(eq(tasksTable.id, a.body.taskId));
    expect(t).toMatchObject({ title: "Reply to Sam Lee on Slack", status: "now", source: "slack", sourceChannel: "Sam Lee" });
    expect((await list()).items[0].taskId).toBe(t.id);

    const done = await api(`email/slack/${it.id}/done`, { method: "POST" });
    expect(done.body).toEqual({ taskId: t.id, previousStatus: "now" });
    const [after] = await db.select().from(tasksTable).where(eq(tasksTable.id, t.id));
    expect(after.status).toBe("done");
    await api(`email/slack/${it.id}/undo-done`, { body: done.body });
    const [back] = await db.select().from(tasksTable).where(eq(tasksTable.id, t.id));
    expect(back.status).toBe("now");
  });

  it("closes a channel mention once Ollie answers in its thread", async () => {
    const at = new Date(Date.now() - HOUR);
    threadLooks = [];
    threadReplied = new Set();
    await check({ units: [unit("C1", "channel", [{ at, text: "@Ollie can you approve this?" }], "#launch")] }, [reply("reply", "Wants your approval")]);
    let l = await list();
    expect(l.items[0]).toMatchObject({ kind: "channel", place: "#launch", needs: "reply" });
    expect(threadLooks).toEqual([`C1:${tsAt(at)}`]);

    threadReplied = new Set([`C1:${tsAt(at)}`]);
    await check({});
    l = await list();
    expect(l.items).toHaveLength(0);
  });

  it("counts messages needing a reply that have waited over a working day, for the digest and Home", async () => {
    const now = new Date();
    const old = new Date(oneWorkingDayBefore(now).getTime() - HOUR);
    const base = { kind: "im", place: "Sam Lee", text: "Hi", url: "https://x.slack.com/archives/D/p1" };
    await db.insert(slackToAnswerTable).values([
      { ...base, conversationId: "DOLD", messageTs: "1", at: old, needs: "reply" },
      { ...base, conversationId: "DUNK", messageTs: "2", at: old, needs: "unknown" },
      { ...base, conversationId: "DINFO", messageTs: "3", at: old, needs: "info" },
      { ...base, conversationId: "DNEW", messageTs: "4", at: new Date(now.getTime() - HOUR), needs: "reply" },
      { ...base, conversationId: "DDONE", messageTs: "5", at: old, needs: "reply", doneTs: "5" },
      { ...base, conversationId: "DGONE", messageTs: "6", at: new Date(now.getTime() - 20 * 86_400_000), needs: "reply" },
    ]);
    expect(await slackRepliesOverdue(now)).toBe(2);
    const home = await api("home");
    expect(home.body.slackToAnswer).toBe(2);
  });

  it("is empty with a pointer while Claude reads Slack", async () => {
    await api("connectors/slack", { method: "PATCH", body: { readBy: "claude" } });
    const l = await list();
    expect(l).toMatchObject({ items: [], readBy: "claude" });
  });
});

describe("the sorter's reply reading", () => {
  const u = (fromMe: boolean, source: WorkUnit["source"] = "slack"): WorkUnit => ({
    source,
    key: "k",
    subject: null,
    channel: null,
    people: [],
    messages: [{ ref: "slack:D:1", at: new Date(), fromMe, fromName: null, fromAddress: null, text: "x", url: "u" }],
  });
  it("only keeps a reading for Slack exchanges whose newest message is from someone else", () => {
    expect(cleanReply("reply", "  Wants   the numbers ", u(false))).toEqual({ needs: "reply", ask: "Wants the numbers" });
    expect(cleanReply("reply", "x", u(true))).toEqual({ needs: "none", ask: "" });
    expect(cleanReply("info", "x", u(false, "email"))).toEqual({ needs: "none", ask: "" });
    expect(cleanReply("maybe", "x", u(false))).toEqual({ needs: "none", ask: "" });
  });
  it("looks back one working day, skipping the weekend", () => {
    // Monday 16th November 2026, 10:00 London, looks back to Friday 13th November.
    const monday = new Date("2026-11-16T10:00:00Z");
    expect(oneWorkingDayBefore(monday).toISOString()).toBe("2026-11-13T10:00:00.000Z");
  });
});
