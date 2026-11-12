import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { activityTable, appSettingsTable, db, noiseRulesTable, peopleTable, tasksTable } from "@workspace/db";
import { groupByThread, mapGmailMessage, parseAddresses, stripQuoted, type GmailRead } from "../src/services/connectors/gmail";
import { pickConversations, plainSlack, usefulMessages, type SlackConv, type SlackRead } from "../src/services/connectors/slack";
import type { SortedUnit } from "../src/services/connectors/sorter";
import type { WorkUnit } from "../src/services/connectors/messages";
import { readByNow } from "../src/services/connectors";
import { api, ingest, useServer } from "./harness";

let nextGmail: GmailRead | Error = { account: "ollie@example.com", units: [], found: 0, leftOut: 0, newest: null, more: false };
let nextSlack: SlackRead | Error = { account: "ollie at Example", units: [], found: 0, leftOut: 0, checked: 0, state: { since: new Date().toISOString(), convs: {} } };
/** What the fake sorter says, one entry per unit in order. */
let nextSorted: SortedUnit[] = [];
let sortedSeen: WorkUnit[][] = [];
let gmailSince: Date[] = [];

vi.mock("../src/services/connectors/gmail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/gmail")>()),
  readGmail: async (since: Date) => {
    gmailSince.push(since);
    if (nextGmail instanceof Error) throw nextGmail;
    return nextGmail;
  },
}));
vi.mock("../src/services/connectors/slack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/slack")>()),
  readSlack: async () => {
    if (nextSlack instanceof Error) throw nextSlack;
    return nextSlack;
  },
}));
vi.mock("../src/services/connectors/sorter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/sorter")>()),
  sortUnits: async (units: WorkUnit[]) => {
    sortedSeen.push(units);
    return units.map((_, i) => nextSorted[i] ?? { summary: "", project: "", items: [] });
  },
}));
vi.mock("../src/services/connectors/googleCalendar", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/googleCalendar")>()),
  readGoogleCalendar: async () => ({ account: null, events: [], found: 0, skipped: 0 }),
}));
vi.mock("../src/services/ask/model", () => ({
  ASK_MODEL: "test-model",
  answerFromDocs: async () => ({ found: false, summary: "", items: [], related: [], bundleTitle: "" }),
  draftReplyFromDocs: async () => "Draft",
  draftCheckInFromDocs: async () => ({ text: "Hi", refs: [] }),
  writeBriefFromDocs: async () => ({ why: [], questions: [], questionsNote: "" }),
  digestSummaryFromLines: async () => "Summary.",
}));

useServer();

const b64 = (s: string) => Buffer.from(s).toString("base64url");
const gmailMsg = (o: { id?: string; from?: string; subject?: string; text?: string; labels?: string[]; headers?: Record<string, string>; thread?: string }) => ({
  id: o.id ?? "m1",
  threadId: o.thread ?? "t1",
  labelIds: o.labels ?? ["INBOX"],
  internalDate: String(Date.parse("2026-11-10T09:00:00Z")),
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: o.from ?? '"Sam Lee" <Sam@Client.com>' },
      { name: "To", value: "Ollie <ollie@example.com>, amy@client.com" },
      { name: "Subject", value: o.subject ?? "Q3 numbers" },
      ...Object.entries(o.headers ?? {}).map(([name, value]) => ({ name, value })),
    ],
    parts: [
      { mimeType: "text/plain", body: { data: b64(o.text ?? "Could you send the Q3 numbers by Friday?\n\nOn Mon, 9 Nov 2026, Ollie wrote:\n> old text") } },
      { mimeType: "text/html", body: { data: b64("<p>html</p>") } },
    ],
  },
});

describe("reading Gmail messages", () => {
  it("keeps a real email, without the quoted reply, linked to the thread", () => {
    const r = mapGmailMessage(gmailMsg({}), "ollie@example.com");
    expect(r.skipped).toBeUndefined();
    expect(r.unit).toMatchObject({
      source: "email",
      key: "gmail:m1",
      subject: "Q3 numbers",
      people: [
        { name: "Sam Lee", email: "sam@client.com" },
        { name: null, email: "amy@client.com" },
      ],
    });
    expect(r.unit!.messages[0]).toMatchObject({ ref: "gmail:m1", fromMe: false, fromName: "Sam Lee", fromAddress: "sam@client.com", text: "Could you send the Q3 numbers by Friday?" });
    expect(r.unit!.messages[0].url).toBe("https://mail.google.com/mail/?authuser=ollie%40example.com#all/t1");
  });

  it("leaves out mailing lists, no-reply senders, invites and drafts", () => {
    expect(mapGmailMessage(gmailMsg({ headers: { "List-Unsubscribe": "<mailto:x>" } }), "ollie@example.com").skipped).toBe("bulk");
    expect(mapGmailMessage(gmailMsg({ from: "Acme <no-reply@acme.com>" }), "ollie@example.com").skipped).toBe("automated");
    expect(mapGmailMessage(gmailMsg({ from: "notifications@github.com" }), "ollie@example.com").skipped).toBe("automated");
    expect(mapGmailMessage(gmailMsg({ subject: "Invitation: Weekly sync @ Tue" }), "ollie@example.com").skipped).toBe("calendar");
    expect(mapGmailMessage(gmailMsg({ labels: ["DRAFT"] }), "ollie@example.com").skipped).toBe("draft");
  });

  it("treats Ollie's sent mail as his, with the recipients as the people", () => {
    const r = mapGmailMessage(gmailMsg({ from: "Ollie <ollie@example.com>", labels: ["SENT"], headers: { "List-Id": "ignored for sent mail" } }), "ollie@example.com");
    expect(r.unit!.messages[0].fromMe).toBe(true);
    expect(r.unit!.people.map((p) => p.email)).toEqual(["amy@client.com"]);
  });

  it("parses address lists with commas inside quotes", () => {
    expect(parseAddresses('"Lee, Sam" <sam@x.com>, amy@y.com')).toEqual([
      { name: "Lee, Sam", email: "sam@x.com" },
      { name: null, email: "amy@y.com" },
    ]);
  });

  it("cuts Outlook-style quoted replies", () => {
    expect(stripQuoted("Yes, will do.\n\nFrom: Sam Lee\nSent: Monday\nTo: Ollie\nSubject: x\nold")).toBe("Yes, will do.\n");
  });

  it("makes one exchange per thread", () => {
    const a = mapGmailMessage(gmailMsg({ id: "a", thread: "t1" }), "ollie@example.com").unit!;
    const b = mapGmailMessage(gmailMsg({ id: "b", thread: "t1", from: "Ollie <ollie@example.com>", labels: ["SENT"] }), "ollie@example.com").unit!;
    const c = mapGmailMessage(gmailMsg({ id: "c", thread: "t2" }), "ollie@example.com").unit!;
    const units = groupByThread([a, b, c]);
    expect(units).toHaveLength(2);
    expect(units[0].messages.map((m) => m.ref)).toEqual(["gmail:a", "gmail:b"]);
    expect(units[0].key).toBe("gmail:b");
  });
});

describe("reading Slack", () => {
  const now = new Date("2026-11-10T10:00:00Z");
  const conv = (id: string, kind: SlackConv["kind"], updated = 0): SlackConv => ({ id, kind, name: null, user: kind === "im" ? "U2" : null, updated });

  it("checks busy conversations every time and quiet ones in turn", () => {
    const convs = [conv("D1", "im"), conv("D2", "im"), conv("D3", "im"), conv("G1", "mpim", 5), conv("G2", "mpim", 9), conv("C1", "channel")];
    const state = {
      since: now.toISOString(),
      convs: {
        D1: { active: now.getTime() - 86_400_000, checked: now.getTime() - 60_000 },
        D2: { checked: now.getTime() - 60_000 },
        G1: { checked: now.getTime() - 3_600_000 },
      },
    };
    const picked = pickConversations(convs, state, now).map((c) => c.id);
    // D1 is busy; D2 was checked a minute ago so waits; D3 was never checked. Unchecked group DMs go first, newest first.
    expect(picked).toEqual(["D1", "D3", "G2", "C1", "G1"]);
  });

  it("keeps people's messages, and only mentions of Ollie in channels", () => {
    const users = new Map([
      ["U1", { name: "Ollie", handle: "ollie", email: "ollie@example.com", bot: false }],
      ["U2", { name: "Sam Lee", handle: "sam", email: "sam@x.com", bot: false }],
      ["B1", { name: "Jira", handle: "jira", email: null, bot: true }],
    ]);
    const msgs = [
      { ts: "1.1", user: "U2", text: "hi <@U1> can you look?" },
      { ts: "1.2", user: "U2", text: "unrelated" },
      { ts: "1.3", user: "B1", text: "<@U1> ticket" },
      { ts: "1.4", user: "U2", subtype: "channel_join", text: "joined" },
    ];
    expect(usefulMessages(msgs, "channel", "U1", users).map((m) => m.ts)).toEqual(["1.1"]);
    expect(usefulMessages(msgs, "im", "U1", users).map((m) => m.ts)).toEqual(["1.1", "1.2"]);
    expect(plainSlack("hi <@U1>, see <https://x.com|the doc> in <#C1|general> &amp; more", users)).toBe("hi @Ollie, see the doc in #general & more");
  });
});

describe("capturing from Gmail and Slack", () => {
  const at = new Date("2026-11-10T09:00:00Z");
  const emailUnit = (id: string, o: Partial<WorkUnit["messages"][0]> = {}): WorkUnit => ({
    source: "email",
    key: `gmail:${id}`,
    subject: "Q3 numbers",
    channel: null,
    people: [{ name: "Sam Lee", email: "sam@client.com" }],
    messages: [{ ref: `gmail:${id}`, at, fromMe: false, fromName: "Sam Lee", fromAddress: "sam@client.com", text: "Could you send the Q3 numbers?", url: "https://mail.google.com/mail/#all/t1", ...o }],
  });
  const item = (o: Partial<SortedUnit["items"][0]>): SortedUnit["items"][0] => ({
    ref: "gmail:m1",
    type: "task",
    title: "Send Sam the Q3 numbers",
    action: "Reply with the numbers.",
    priority: "medium",
    due: "2026-11-13",
    project: "",
    person: "sam@client.com",
    quote: "Could you send the Q3 numbers?",
    confidential: false,
    ...o,
  });

  it("adds tasks and promises to the Inbox (waiting on from sent email is left to Waiting for a reply), logs activity with known people, and carries on from where it got to", async () => {
    const [sam] = await db.insert(peopleTable).values({ name: "Sam Lee", slug: "sam-lee", email: "sam@client.com" }).returning();
    const newest = new Date("2026-11-10T09:30:00Z");
    nextGmail = {
      account: "ollie@example.com",
      units: [emailUnit("m1"), emailUnit("m2", { fromMe: true, fromName: null, fromAddress: "ollie@example.com" })],
      found: 4,
      leftOut: 2,
      newest,
      more: false,
    };
    nextSorted = [
      { summary: "Sam asked for the Q3 numbers", project: "", items: [item({})] },
      {
        summary: "You told Sam you would send the deck",
        project: "",
        items: [item({ ref: "gmail:m2", type: "promise", title: "Send Sam the deck" }), item({ ref: "gmail:m2", type: "waiting", title: "Sam to send the contract", priority: "high" })],
      },
    ];
    gmailSince = [];

    const check = await api("connectors/gmail/check", { method: "POST" });
    expect(check.body).toMatchObject({ ok: true, found: 4, account: "ollie@example.com" });
    expect(check.body.counts).toMatchObject({ inbox: 1, promises: 1, waiting: 0, left_out: 2, activity: 2 });

    const tasks = await db.select().from(tasksTable).orderBy(tasksTable.id);
    expect(tasks.map((t) => [t.title, t.kind, t.status, t.source, t.sourceRef])).toEqual([
      ["Send Sam the Q3 numbers", "task", "inbox", "email", "gmail:m1"],
      ["Send Sam the deck", "promise", "inbox", "email", "gmail:m2"],
    ]);
    expect(tasks[0]).toMatchObject({ personId: sam.id, fromName: "Sam Lee", dueDate: "2026-11-13", createdBy: "ollieos" });
    expect((await db.select().from(activityTable)).map((a) => a.summary).sort()).toEqual(["Sam asked for the Q3 numbers", "You told Sam you would send the deck"]);
    expect(await readByNow("gmail")).toBe("ollieos");

    // The next check starts where this one finished, and the same messages are not added twice.
    const again = await api("connectors/gmail/check", { method: "POST" });
    expect(gmailSince[1].toISOString()).toBe(newest.toISOString());
    expect(again.body.counts).toMatchObject({ inbox: 0, duplicate: 2, activity: 0 });

    // Claude's copy of email is now refused, both tasks and activity.
    const refused = await ingest("tasks", { body: [{ source: "email", source_ref: "claude-1", title: "From Claude" }, { source: "meeting", source_ref: "g-1", title: "Meeting action" }] });
    expect(refused.body.results.map((r: { outcome: string }) => r.outcome)).toEqual(["ignored", "created"]);
    const act = await ingest("activity", { body: [{ kind: "email", summary: "x", occurred_at: at.toISOString() }] });
    expect(act.body.results[0].outcome).toBe("ignored");
  });

  it("skips exchanges covered by a noise rule before any AI sees them", async () => {
    await db.insert(noiseRulesTable).values({ matchType: "from_domain_equals", matchValue: "client.com" });
    nextGmail = { account: "ollie@example.com", units: [emailUnit("m1")], found: 1, leftOut: 0, newest: at, more: false };
    sortedSeen = [];
    const check = await api("connectors/gmail/check", { method: "POST" });
    expect(check.body.counts).toMatchObject({ noise_rule: 1, inbox: 0 });
    expect(sortedSeen).toEqual([]);
  });

  it("marks items confidential when the AI says so, and keeps the cursor when a check fails", async () => {
    nextGmail = { account: "ollie@example.com", units: [emailUnit("m1")], found: 1, leftOut: 0, newest: at, more: false };
    nextSorted = [{ summary: "", project: "", items: [item({ confidential: true, title: "Review the EMI agreement" })] }];
    await api("connectors/gmail/check", { method: "POST" });
    const [t] = await db.select().from(tasksTable);
    expect(t.confidential).toBe(true);

    nextGmail = new (await import("../src/services/connectors/http")).ConnectorError("Gmail refused access. Reconnect it in Replit.", true);
    const failed = await api("connectors/gmail/check", { method: "POST" });
    expect(failed.body).toMatchObject({ ok: false, needsReconnect: true });
    const [saved] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, "connector_state_gmail"));
    expect(saved.value).toEqual({ after: at.toISOString() });
  });

  it("finds who a waiting item is on from a first name, the DM, or the sender, and never guesses between two", async () => {
    const add = async (name: string, slackUserId: string | null = null, isSelf = false) =>
      (await db.insert(peopleTable).values({ name, slug: name.toLowerCase().replace(/\W+/g, "-"), slackUserId, isSelf }).returning())[0];
    await add("Ollie Fisher", "U_ME", true);
    const vol = await add("Volodymyr Petrenko", "U_VOL");
    const andy = await add("Andy Hall", "U_ANDY");
    const kevin = await add("Kevin Brown");
    await add("Paul Jones");
    await add("Paul Smith");
    const dm = (id: string, who: { name: string; slackId: string }, ts: string, fromMe: boolean, text: string): WorkUnit => ({
      source: "slack",
      key: `slack:${id}:${ts}`,
      subject: null,
      channel: who.name,
      people: [{ name: who.name, email: null, slackId: who.slackId }],
      messages: [{ ref: `slack:${id}:${ts}`, at, fromMe, fromName: fromMe ? null : who.name, fromAddress: null, fromSlackId: fromMe ? "U_ME" : who.slackId, text, url: `https://x.slack.com/archives/${id}/p${ts}` }],
      conversation: { id, kind: "im" },
    });
    const V = { name: "Volodymyr Petrenko", slackId: "U_VOL" };
    const A = { name: "Andy Hall", slackId: "U_ANDY" };
    const units = [
      dm("D1", V, "1.1", true, "Shall we set it up in Route53?"),
      dm("D1", V, "1.2", true, "Can you send the invoice too?"),
      dm("D2", A, "2.1", true, "He is going to get back to me"),
      dm("D2", A, "2.2", true, "Waiting to hear from Kevin"),
      dm("D2", A, "2.3", false, "I'll send the list on Friday"),
      dm("D2", A, "2.4", true, "I'll ask myself"),
    ];
    nextSlack = { account: "ollie at Example", found: units.length, leftOut: 0, checked: 1, state: { since: at.toISOString(), convs: {} }, units };
    const wait = (ref: string, title: string, person: string) => ({ summary: "", project: "", items: [item({ ref, type: "waiting", title, person })] });
    nextSorted = [
      wait("slack:D1:1.1", "Volodymyr to set up springpod.io in Route53", ""),
      wait("slack:D1:1.2", "Volodymyr to send the invoice", "Volodymyr"),
      wait("slack:D2:2.1", "Paul (RAF) to reply about ADS event", "Paul (RAF)"),
      wait("slack:D2:2.2", "Kevin to confirm Strada panel participation", "Kevin"),
      wait("slack:D2:2.3", "Andy to send the list", ""),
      wait("slack:D2:2.4", "Ask about the venue", "Ollie"),
    ];
    const check = await api("connectors/slack/check", { method: "POST" });
    expect(check.body.counts).toMatchObject({ waiting: 6 });
    const tasks = await db.select().from(tasksTable).orderBy(tasksTable.id);
    expect(tasks.map((t) => [t.title, t.waitingOnPersonId, t.personId])).toEqual([
      // Ollie's message in a DM with no name given: the other person in the DM.
      ["Volodymyr to set up springpod.io in Route53", vol.id, null],
      // A first name that fits the person in the exchange.
      ["Volodymyr to send the invoice", vol.id, null],
      // Two Pauls in People and neither in the DM: nobody, and never Andy.
      ["Paul (RAF) to reply about ADS event", null, null],
      // The only Kevin in People, though not in the DM.
      ["Kevin to confirm Strada panel participation", kevin.id, null],
      // Andy wrote it: waiting on the sender.
      ["Andy to send the list", andy.id, null],
      // Never Ollie himself.
      ["Ask about the venue", null, null],
    ]);
  });

  it("saves Slack's place and refuses Claude's Slack items", async () => {
    const state = { since: at.toISOString(), convs: { D1: { ts: "1731229200.000100", checked: at.getTime() } } };
    nextSlack = {
      account: "ollie at Example",
      found: 1,
      leftOut: 0,
      checked: 1,
      state,
      units: [
        {
          source: "slack",
          key: "slack:D1:1731229200.000100",
          subject: null,
          channel: "Sam Lee",
          people: [{ name: "Sam Lee", email: "sam@client.com" }],
          messages: [{ ref: "slack:D1:1731229200.000100", at, fromMe: false, fromName: "Sam Lee", fromAddress: "sam@client.com", text: "Can you review the plan?", url: "https://x.slack.com/archives/D1/p1731229200000100" }],
        },
      ],
    };
    nextSorted = [{ summary: "Sam asked for a review", project: "", items: [item({ ref: "slack:D1:1731229200.000100", title: "Review Sam's plan" })] }];
    const check = await api("connectors/slack/check", { method: "POST" });
    expect(check.body).toMatchObject({ ok: true, found: 1 });
    const [t] = await db.select().from(tasksTable);
    expect(t).toMatchObject({ source: "slack", sourceChannel: "Sam Lee", sourceUrl: "https://x.slack.com/archives/D1/p1731229200000100" });
    const [saved] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, "connector_state_slack"));
    expect(saved.value).toEqual(state);
    const refused = await ingest("tasks", { body: [{ source: "slack", source_ref: "claude-s", title: "From Claude" }] });
    expect(refused.body.results[0].outcome).toBe("ignored");
  });
});
