/**
 * Part P (build plan section 19): Slack to answer. The Slack check keeps a row per conversation whose
 * newest message is from someone else; Ollie's reply closes it; Done hides it until a newer message.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditEventsTable, db, peopleTable, reviewItemsTable, slackToAnswerTable, tasksTable } from "@workspace/db";
import type { SlackRead } from "../src/services/connectors/slack";
import { cleanReply, type SortedUnit } from "../src/services/connectors/sorter";
import type { WorkUnit } from "../src/services/connectors/messages";
import { isAcknowledgement, oneWorkingDayBefore, slackRepliesOverdue, slackToAnswerIdle } from "../src/services/slackToAnswer";
import { api, useServer } from "./harness";
import { person } from "./helpers";

const emptyRead = (): SlackRead => ({ account: "ollie at Example", me: "UME", opened: [], units: [], found: 0, leftOut: 0, checked: 0, state: { since: new Date().toISOString(), convs: {} } });
let nextSlack: SlackRead = emptyRead();
let nextSorted: SortedUnit[] = [];
let threadReplied = new Set<string>();
let threadLooks: string[] = [];
let drafts: { to: string; messages: unknown[]; brief?: string | null; change?: { current: string; ask: string } | null }[] = [];
/** Conversations Ollie has written in since the waiting message, for the look between checks */
let wrote = new Set<string>();

vi.mock("../src/services/connectors/slack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/slack")>()),
  readSlack: async () => nextSlack,
  repliedInThread: async (conv: string, ts: string) => {
    threadLooks.push(`${conv}:${ts}`);
    return threadReplied.has(`${conv}:${ts}`);
  },
  slackMe: async () => "UME",
  wroteSince: async (conv: string) => wrote.has(conv),
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
  draftSlackReplyFromDocs: async (o: (typeof drafts)[number]) => {
    drafts.push(o);
    return o.change ? "Will send by Friday." : o.brief ? "Yes, Friday works." : "Hi Sam, I'll send them over by Friday.";
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

const reply = (needs: "reply" | "info" | "done" | "awaiting" | "none", ask: string): SortedUnit => ({ summary: "", project: "", items: [], reply: { needs, ask } });

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
    expect(d.body).toMatchObject({ text: "Hi Sam, I'll send them over by Friday.", brief: null });
    expect(drafts[0]).toMatchObject({ to: "Sam Lee" });
    expect(drafts[0].messages).toHaveLength(1);
    // Still waiting, with the draft kept on it so it shows on Drafts.
    const kept = (await list()).items;
    expect(kept).toHaveLength(1);
    expect(kept[0].draft).toMatchObject({ text: "Hi Sam, I'll send them over by Friday.", brief: null });
    const audit = await db.select().from(auditEventsTable).where(eq(auditEventsTable.action, "draft"));
    expect(audit.some((a) => (a.payload as { via?: string }).via === "slack_to_answer")).toBe(true);
  });

  it("keeps a briefed draft, changes it, saves Ollie's edits, and clears it when he answers", async () => {
    const sam = await person("Sam Lee");
    await db.update(peopleTable).set({ slackUserId: "USAM" }).where(eq(peopleTable.id, sam.id));
    const asked = new Date(Date.now() - 2 * HOUR);
    await check({ units: [unit("D7", "im", [{ at: asked }])] }, [reply("reply", "Wants numbers")]);
    const [it] = (await list()).items;
    drafts = [];

    // A change with no draft to change is refused.
    expect((await api(`email/slack/${it.id}/draft`, { body: { change: "shorter" } })).status).toBe(400);
    const briefed = await api(`email/slack/${it.id}/draft`, { body: { brief: "yes, Friday" } });
    expect(briefed.body).toMatchObject({ text: "Yes, Friday works.", brief: "yes, Friday" });
    expect(drafts[0]).toMatchObject({ brief: "yes, Friday", change: null });

    const changed = await api(`email/slack/${it.id}/draft`, { body: { change: "shorter" } });
    expect(changed.body).toMatchObject({ text: "Will send by Friday.", brief: "yes, Friday" });
    expect(drafts[1]).toMatchObject({ brief: "yes, Friday", change: { current: "Yes, Friday works.", ask: "shorter" } });

    const edited = await api(`email/slack/${it.id}/draft`, { method: "PUT", body: { text: "Will send it Friday morning." } });
    expect(edited.body).toMatchObject({ text: "Will send it Friday morning.", brief: "yes, Friday" });
    expect((await list()).items[0].draft.text).toBe("Will send it Friday morning.");
    // A message with a draft is on Drafts, so it is not counted as needing a reply.
    expect((await api("email/counts")).body.needsReply).toBe(0);

    // Remove draft: back to a plain message waiting.
    expect((await api(`email/slack/${it.id}/draft`, { method: "DELETE" })).status).toBe(204);
    expect((await list()).items[0].draft).toBeNull();

    // Drafted again, then Ollie answers in Slack: the row closes and the draft goes with it.
    await api(`email/slack/${it.id}/draft`, { method: "POST" });
    const answered = new Date(Date.now() - HOUR);
    await check({ units: [unit("D7", "im", [{ at: answered, fromMe: true, text: "Will do" }])], opened: [{ id: "D7", kind: "im", mineTs: tsAt(answered) }] });
    expect((await list()).items).toHaveLength(0);
    const [row] = await db.select().from(slackToAnswerTable).where(eq(slackToAnswerTable.conversationId, "D7"));
    expect(row).toMatchObject({ draftText: null, draftBrief: null });
  });

  it("shows the conversation, from Slack", async () => {
    await check({ units: [unit("D8", "im", [{ at: new Date(Date.now() - HOUR) }])] }, [reply("reply", "Wants numbers")]);
    const [it] = (await list()).items;
    const c = await api(`email/slack/${it.id}/messages`);
    expect(c.status).toBe(200);
    expect(c.body.fromSlack).toBe(true);
    expect(c.body.messages).toHaveLength(1);
    expect(c.body.messages[0]).toMatchObject({ fromName: "Sam Lee", fromOllie: false, text: "Can you send the pilot numbers by Friday?" });
    expect((await api("email/slack/99999/messages")).status).toBe(404);
  });

  it("looks again between checks and closes a conversation Ollie has answered", async () => {
    const asked = new Date(Date.now() - 2 * HOUR);
    await check({ units: [unit("D9", "im", [{ at: asked }]), unit("D10", "im", [{ at: new Date(asked.getTime() + 1000) }], "Amy Wu")] }, [reply("reply", "Wants numbers"), reply("reply", "Wants a date")]);
    expect((await list()).items).toHaveLength(2);
    await slackToAnswerIdle();

    // Ollie replied to Sam in Slack since: the look closes that one and leaves the other.
    wrote = new Set(["D9"]);
    const r = await api("email/slack/refresh", { method: "POST" });
    expect(r.body).toEqual({ closed: 1 });
    wrote = new Set();
    const l = await list();
    expect(l.items.map((i) => i.place)).toEqual(["Amy Wu"]);
    await slackToAnswerIdle();
  });

  it("Later hides a message until its day or a newer message", async () => {
    const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    await check({ units: [unit("D11", "im", [{ at: new Date(Date.now() - 3 * HOUR) }])] }, [reply("reply", "Wants numbers")]);
    const [it] = (await list()).items;
    expect((await api(`email/slack/${it.id}/later`, { body: { until: "2020-01-01" } })).status).toBe(400);
    expect((await api(`email/slack/${it.id}/later`, { body: { until: day } })).status).toBe(204);
    expect((await list()).items[0].snoozedUntil).toBe(day);
    expect((await api("email/counts")).body.needsReply).toBe(0);

    // The same message read again stays hidden; a newer one brings it back.
    await check({ units: [unit("D11", "im", [{ at: new Date(Date.now() - HOUR), text: "It is urgent now" }])] }, [reply("reply", "Chasing the numbers")]);
    expect((await list()).items[0]).toMatchObject({ snoozedUntil: null, ask: "Chasing the numbers" });

    // Bring back.
    await api(`email/slack/${it.id}/later`, { body: { until: day } });
    await api(`email/slack/${it.id}/later`, { body: { until: null } });
    expect((await list()).items[0].snoozedUntil).toBeNull();
    await slackToAnswerIdle();
  });

  it("Mute leaves a channel's mentions off the list, and Mark all done clears several with one Undo", async () => {
    threadReplied = new Set();
    const at = new Date(Date.now() - HOUR);
    await check(
      { units: [unit("C2", "channel", [{ at, text: "@Ollie fyi the deck is up" }], "#noisy"), unit("D12", "im", [{ at }]), unit("D13", "im", [{ at: new Date(at.getTime() + 1000) }], "Amy Wu")] },
      [reply("info", "The deck is up"), reply("info", "An update"), reply("info", "Another update")],
    );
    expect((await list()).items).toHaveLength(3);

    const m = await api("noise-rules", { body: { matchType: "slack_channel_equals", matchValue: "#noisy" } });
    expect(m.body).toMatchObject({ created: true, rule: { matchType: "slack_channel_equals", matchValue: "noisy", source: "slack" } });
    const left = (await list()).items;
    expect(left.map((i) => i.place).sort()).toEqual(["Amy Wu", "Sam Lee"]);

    const d = await api("email/done-many", { body: { threadIds: [], slackIds: left.map((i) => i.id) } });
    expect(d.body.slack.map((x: { id: number }) => x.id).sort()).toEqual(left.map((i) => i.id).sort());
    expect((await list()).items).toHaveLength(0);
    expect((await api("email/undo-done-many", { body: d.body })).status).toBe(204);
    expect((await list()).items).toHaveLength(2);
    await slackToAnswerIdle();
  });

  it("puts a Slack message Ollie sent that asks for something on Waiting for a reply, and closes it when they answer", async () => {
    const sam = await person("Sam Lee");
    await db.update(peopleTable).set({ slackUserId: "USAM" }).where(eq(peopleTable.id, sam.id));
    const sent = new Date(Date.now() - 2 * HOUR);
    await check(
      { units: [unit("D14", "im", [{ at: sent, fromMe: true, text: "Can you send me the pilot numbers?" }]), unit("D15", "im", [{ at: sent, fromMe: true, text: "Thanks, all good" }], "Amy Wu")] },
      [reply("awaiting", "Sam to send the pilot numbers"), reply("none", "")],
    );
    let review = (await api("review")).body;
    expect(review.items).toHaveLength(1);
    expect(review.items[0]).toMatchObject({ kind: "no_reply", via: "slack", text: "Sam to send the pilot numbers", owner: "Sam Lee", meetingTitle: "Slack message to Sam Lee", quote: "Can you send me the pilot numbers?" });
    expect(review.items[0].person).toMatchObject({ id: sam.id });
    // Nothing on To answer: Ollie wrote last.
    expect((await list()).items).toHaveLength(0);

    // A second message from Ollie does not add another.
    await check({ units: [unit("D14", "im", [{ at: new Date(sent.getTime() + 60_000), fromMe: true, text: "Any chance today?" }])] }, [reply("awaiting", "Sam to send the numbers today")]);
    expect((await api("review")).body.items).toHaveLength(1);

    // Chase makes a Slack waiting-on task.
    const id = review.items[0].id;
    // Sam answers: closed as answered, and now it is To answer.
    await check({ units: [unit("D14", "im", [{ at: new Date(Date.now() - HOUR), text: "Here they are. Do they look right?" }])] }, [reply("reply", "Asks if the numbers look right")]);
    review = (await api("review")).body;
    expect(review.items).toHaveLength(0);
    const [row] = await db.select().from(reviewItemsTable).where(eq(reviewItemsTable.id, id));
    expect(row.state).toBe("answered");
    expect((await list()).items).toHaveLength(1);
    await slackToAnswerIdle();
  });

  it("chases a Slack message with a Slack waiting-on task", async () => {
    const sent = new Date(Date.now() - 2 * HOUR);
    await check({ units: [unit("D16", "im", [{ at: sent, fromMe: true, text: "Can you confirm the venue?" }])] }, [reply("awaiting", "Sam to confirm the venue")]);
    const [item] = (await api("review")).body.items;
    const r = await api("review/decide", { body: { ids: [item.id], action: "waiting" } });
    expect(r.status).toBe(200);
    const [t] = await db.select().from(tasksTable).where(eq(tasksTable.id, r.body.items[0].taskId));
    expect(t).toMatchObject({ status: "waiting", source: "slack", title: "Sam to confirm the venue", sourceChannel: "Sam Lee" });
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

  it("closes a conversation when the newest message needs nothing from Ollie", async () => {
    // Asked, then thanked: the thanks closes it, by the text alone.
    await check({ units: [unit("D6", "im", [{ at: new Date(Date.now() - 3 * HOUR) }])] }, [reply("reply", "Wants numbers")]);
    expect((await list()).items).toHaveLength(1);
    await check({ units: [unit("D6", "im", [{ at: new Date(Date.now() - 2 * HOUR), text: "perfect thank you!" }])] }, [reply("info", "Says thanks")]);
    expect((await list()).items).toHaveLength(0);

    // The AI reads a group DM as needing nothing: not listed, though the words are not a plain thanks.
    await check({ units: [unit("G1", "mpim", [{ at: new Date(Date.now() - HOUR), text: "all working on my side now, legend" }], "Zoe, Konrad")] }, [reply("done", "")]);
    expect((await list()).items).toHaveLength(0);
    expect(await db.select().from(slackToAnswerTable).where(eq(slackToAnswerTable.conversationId, "G1"))).toHaveLength(0);

    // A row kept before this change, an acknowledgement waiting as not read by AI, is left out.
    await db.insert(slackToAnswerTable).values({ conversationId: "DOLDACK", kind: "im", place: "Saish", text: "working now thanks Ollie", url: "u", messageTs: "9", at: new Date(Date.now() - HOUR), needs: "unknown" });
    expect((await list()).items.map((i) => i.place)).not.toContain("Saish");
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
    expect(cleanReply(undefined, undefined, u(false))).toEqual({ needs: "none", ask: "" });
    // "none" for someone else's Slack message means it needs nothing from Ollie.
    expect(cleanReply("none", "", u(false))).toEqual({ needs: "done", ask: "" });
    expect(cleanReply("none", "", u(true))).toEqual({ needs: "none", ask: "" });
    // Ollie wrote last and asked for something: waiting for an answer. Never when someone else wrote last.
    expect(cleanReply("awaiting", " Sam to send  numbers", u(true))).toEqual({ needs: "awaiting", ask: "Sam to send numbers" });
    expect(cleanReply("awaiting", "x", u(false))).toEqual({ needs: "none", ask: "" });
  });
  it("knows a plain thanks or acknowledgement from a message that asks or tells something", () => {
    for (const t of ["perfect thank you!", "working now thanks Ollie", "👍", ":+1:", "Thanks Zoe 🙏", "ok", "sounds good, thanks!", "<@U123> thanks!", "Great, thank you so much Ollie!!"]) {
      expect(isAcknowledgement(t), t).toBe(true);
    }
    for (const t of ["Thanks! One more thing?", "thanks, the client said no", "great news, we signed the contract", "ok I'll send it tomorrow", "Thanks, could you also check the invoice"]) {
      expect(isAcknowledgement(t), t).toBe(false);
    }
  });
  it("looks back one working day, skipping the weekend", () => {
    // Monday 16th November 2026, 10:00 London, looks back to Friday 13th November.
    const monday = new Date("2026-11-16T10:00:00Z");
    expect(oneWorkingDayBefore(monday).toISOString()).toBe("2026-11-13T10:00:00.000Z");
  });
});
