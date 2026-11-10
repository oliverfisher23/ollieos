/**
 * Assist Part D: No reply yet. A look through sent mail finds emails Ollie wrote last that asked
 * for something, leaves out the rest before AI sees them, and puts the found ones on Review.
 * Chase, Already handled and Dropped; answered emails close themselves; Gmail checks keep it up to date.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, peopleTable, replyDraftsTable, reviewItemsTable, tasksTable } from "@workspace/db";
import { todayLondon } from "@workspace/shared";
import { afterWorkingDays, expectedByDate, refreshNoReply, waitForNoReplyScan } from "../src/services/connectors/noReply";
import { checkSentDrafts } from "../src/services/email";
import type { NoReplyCandidate, NoReplyVerdict } from "../src/services/connectors/noReplyJudge";
import { api, OLLIE, useServer } from "./harness";
import { person } from "./helpers";

/* ---------- A fake Gmail behind the connector proxy ---------- */

interface FakeMessage {
  id: string;
  from: string;
  to: string;
  cc?: string;
  subject: string;
  at: Date;
  text: string;
  labels?: string[];
  headers?: Record<string, string>;
}

let threads: Record<string, FakeMessage[]> = {};
let listQueries: string[] = [];

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

function gmailMessage(threadId: string, m: FakeMessage) {
  const headers = [
    { name: "From", value: m.from },
    { name: "To", value: m.to },
    ...(m.cc ? [{ name: "Cc", value: m.cc }] : []),
    { name: "Subject", value: m.subject },
    { name: "Message-ID", value: `<${m.id}@mail>` },
    ...Object.entries(m.headers ?? {}).map(([name, value]) => ({ name, value })),
  ];
  const fromMe = m.from.includes(OLLIE);
  return {
    id: m.id,
    threadId,
    labelIds: m.labels ?? (fromMe ? ["SENT"] : ["INBOX"]),
    internalDate: String(m.at.getTime()),
    snippet: m.text.slice(0, 150),
    payload: { mimeType: "text/plain", headers, body: { data: b64(m.text) } },
  };
}

vi.mock("../src/services/connectors/http", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/connectors/http")>();
  const json = (path: string): Record<string, unknown> | null => {
    const url = new URL("https://x" + path);
    if (url.pathname === "/gmail/v1/users/me/profile") return { emailAddress: OLLIE };
    if (url.pathname === "/gmail/v1/users/me/threads") {
      const q = url.searchParams.get("q") ?? "";
      listQueries.push(q);
      const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0) * 1000;
      const sentOnly = q.includes("in:sent");
      const ids = Object.entries(threads)
        .filter(([, msgs]) => msgs.some((m) => m.at.getTime() > after && (!sentOnly || m.from.includes(OLLIE))))
        .map(([id]) => ({ id }));
      return { threads: ids };
    }
    const m = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const hit = Object.entries(threads).find(([, msgs]) => msgs.some((x) => x.id === decodeURIComponent(m[1])));
      return hit ? { id: m[1], threadId: hit[0] } : null;
    }
    const t = /^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/.exec(url.pathname);
    if (t) {
      const id = decodeURIComponent(t[1]);
      const msgs = threads[id];
      return msgs ? { id, messages: msgs.map((m) => gmailMessage(id, m)) } : null;
    }
    throw new Error("Unexpected path " + path);
  };
  return {
    ...real,
    proxyJson: async (_c: string, _n: string, path: string) => json(path) ?? {},
    proxyJsonOrNull: async (_c: string, _n: string, path: string) => json(path),
  };
});

/* ---------- A fake AI check: verdicts by subject ---------- */

let verdicts: Record<string, Partial<NoReplyVerdict>> = {};
let judged: NoReplyCandidate[] = [];
let gate: Promise<void> | null = null;

vi.mock("../src/services/connectors/noReplyJudge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/noReplyJudge")>()),
  judgeNoReply: async (list: NoReplyCandidate[]) => {
    if (gate) await gate;
    judged.push(...list);
    return list.map((c) => {
      const v = verdicts[c.subject ?? ""];
      return {
        id: c.id,
        expectsReply: !!v,
        ask: "",
        reason: "",
        chase: "",
        person: "",
        quote: "",
        priority: "medium",
        project: "",
        confidential: false,
        ...v,
      };
    });
  },
}));

let draftCalls: { chase?: boolean; thread: { fromOllie: boolean }[]; instructions?: string; current?: string }[] = [];
vi.mock("../src/services/ask/model", async (orig) => ({
  ...(await orig<typeof import("../src/services/ask/model")>()),
  draftEmailReplyFromDocs: async (opts: { chase?: boolean; thread: { fromOllie: boolean }[]; instructions?: string; current?: string }) => {
    draftCalls.push(opts);
    return "Hi Sam,\n\nJust checking in on the contract.\n\nBest, Ollie";
  },
}));

useServer();

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const ME = `Ollie Fisher <${OLLIE}>`;

beforeEach(() => {
  threads = {};
  listQueries = [];
  verdicts = {};
  judged = [];
  gate = null;
  draftCalls = [];
});

async function scan() {
  const r = await api("review/no-reply", { body: {} });
  expect(r.status).toBe(200);
  await waitForNoReplyScan();
  return (await api("review/no-reply")).body;
}

async function pendingNoReply() {
  const r = await api("review");
  expect(r.status).toBe(200);
  return (r.body.items as Record<string, any>[]).filter((i) => i.kind === "no_reply");
}

/** The usual mix: one real unanswered ask, and one of each thing that must be left out. */
function mixedSentMail() {
  threads = {
    contract: [
      { id: "c1", from: "Sam Lee <sam@client.com>", to: ME, subject: "Contract", at: ago(14), text: "Here is the draft contract." },
      { id: "c2", from: ME, to: "Sam Lee <sam@client.com>", subject: "Re: Contract", at: ago(10), text: "Thanks Sam. Could you send the signed copy by Friday?" },
    ],
    answered: [
      { id: "a1", from: ME, to: "Amy <amy@client.com>", subject: "Workshop", at: ago(12), text: "Can you do Tuesday?" },
      { id: "a2", from: "Amy <amy@client.com>", to: ME, subject: "Re: Workshop", at: ago(11), text: "Tuesday works." },
    ],
    newsletter: [
      { id: "n1", from: "News <news@weekly.com>", to: ME, subject: "This week", at: ago(20), text: "Our news.", headers: { "List-Unsubscribe": "<mailto:x@weekly.com>" } },
      { id: "n2", from: ME, to: "News <news@weekly.com>", subject: "Re: This week", at: ago(19), text: "Could you take me off this list?" },
    ],
    robot: [{ id: "r1", from: ME, to: "noreply@tool.com", subject: "Support", at: ago(9), text: "Can you reset my account?" }],
    invite: [{ id: "i1", from: ME, to: "Bea <bea@client.com>", subject: "Accepted: Planning", at: ago(9), text: "Ollie has accepted this invitation." }],
    thanks: [
      { id: "t1", from: "Raj <raj@client.com>", to: ME, subject: "Slides", at: ago(9), text: "Slides attached." },
      { id: "t2", from: ME, to: "Raj <raj@client.com>", subject: "Re: Slides", at: ago(8), text: "Thanks Raj, great!" },
    ],
    self: [{ id: "s1", from: ME, to: ME, subject: "Note to self", at: ago(9), text: "Remember the budget?" }],
    fyi: [{ id: "f1", from: ME, to: "Kim <kim@client.com>", subject: "FYI", at: ago(9), text: "Sharing the report for your records." }],
    recent: [{ id: "x1", from: ME, to: "Lou <lou@client.com>", subject: "Pricing", at: new Date(Date.now() - 3600_000), text: "Can you confirm the price?" }],
    ooo: [
      { id: "o1", from: ME, to: "Jo <jo@client.com>", subject: "Venue", at: ago(9), text: "Can you book the venue?" },
      { id: "o2", from: "Jo <jo@client.com>", to: ME, subject: "Automatic reply: Venue", at: ago(9), text: "I am out of the office.", headers: { "Auto-Submitted": "auto-replied" } },
    ],
  };
  verdicts = {
    "Re: Contract": { ask: "Sam to send the signed contract", reason: "You asked for the signed copy by Friday.", chase: "Ask Sam whether the contract is signed.", person: "Sam Lee", quote: "Could you send the signed copy by Friday?", priority: "high" },
    Venue: { ask: "Jo to book the venue", reason: "You asked Jo to book it.", chase: "Ask Jo if the venue is booked.", person: "jo@client.com" },
  };
}

describe("working days", () => {
  it("counts Monday to Friday only", () => {
    // Friday 6th November 2026, 15:00 London: three working days later is Wednesday.
    const fri = new Date("2026-11-06T15:00:00Z");
    expect(afterWorkingDays(fri).toISOString()).toBe("2026-11-11T15:00:00.000Z");
    const mon = new Date("2026-11-09T09:00:00Z");
    expect(afterWorkingDays(mon).toISOString()).toBe("2026-11-12T09:00:00.000Z");
  });
});

describe("No reply yet", () => {
  it("finds unanswered asks, leaves out the rest before AI sees them, and links the person", async () => {
    const sam = await person("Sam Lee");
    await db.update(peopleTable).set({ email: "sam@client.com" }).where(eq(peopleTable.id, sam.id));
    mixedSentMail();

    const s = await scan();
    expect(s.status).toBe("done");
    expect(s.counts.threads).toBe(10);
    expect(listQueries[0]).toMatch(/^in:sent after:\d+$/);

    // Only the real asks and the FYI reach AI, including one sent an hour ago; an out-of-office is not an answer.
    expect(judged.map((c) => c.subject).sort()).toEqual(["FYI", "Pricing", "Re: Contract", "Venue"]);
    expect(s.counts).toMatchObject({ answered: 1, left_out: 5, checked: 4, found: 2, failed: 0 });
    const contract = judged.find((c) => c.subject === "Re: Contract")!;
    expect(contract.text).toContain("signed copy");
    expect(contract.earlier).toHaveLength(1);
    expect(contract.earlier[0].fromOllie).toBe(false);

    const items = await pendingNoReply();
    expect(items.map((i) => i.text)).toEqual(["Jo to book the venue", "Sam to send the signed contract"]);
    const it = items.find((i) => i.text.startsWith("Sam"))!;
    expect(it).toMatchObject({
      owner: "Sam Lee",
      email: "sam@client.com",
      reason: "You asked for the signed copy by Friday.",
      action: "Ask Sam whether the contract is signed.",
      meetingTitle: "Re: Contract",
      priority: "high",
      suggestedType: "waiting",
    });
    expect(it.person.id).toBe(sam.id);
    expect(it.sourceUrl).toContain("#all/contract");
    expect(items.find((i) => i.text.startsWith("Jo"))!.owner).toBe("Jo");

    const review = (await api("review")).body;
    expect(review).toMatchObject({ actions: 0, noReply: 2, pending: 2 });

    // A second look through checks nothing again and adds nothing.
    judged = [];
    const again = await scan();
    expect(judged).toHaveLength(0);
    expect(again.counts.found).toBe(0);
    expect(await pendingNoReply()).toHaveLength(2);
  });

  it("leaves out a thread that is already a Waiting on task", async () => {
    mixedSentMail();
    await db.insert(tasksTable).values({ title: "Sam to send the contract", status: "waiting", source: "email", sourceRef: "gmail:c2", createdBy: "ollieos" });
    await scan();
    expect(judged.map((c) => c.subject)).not.toContain("Re: Contract");
    expect((await pendingNoReply()).map((i) => i.text)).toEqual(["Jo to book the venue"]);
  });

  it("Chase makes a Waiting on task with the chase line, and Draft reply writes a follow-up", async () => {
    const sam = await person("Sam Lee");
    await db.update(peopleTable).set({ email: "sam@client.com" }).where(eq(peopleTable.id, sam.id));
    mixedSentMail();
    await scan();
    const item = (await pendingNoReply()).find((i) => i.text.startsWith("Sam"))!;

    // Now and Backlog do not apply to an unanswered email.
    expect((await api("review/decide", { body: { ids: [item.id], action: "now" } })).status).toBe(400);

    const r = await api("review/decide", { body: { ids: [item.id], action: "waiting" } });
    expect(r.status).toBe(200);
    const taskId = r.body.items[0].taskId as number;
    const [t] = await db.select().from(tasksTable).where(eq(tasksTable.id, taskId));
    expect(t).toMatchObject({
      title: "Sam to send the signed contract",
      status: "waiting",
      source: "email",
      sourceRef: "gmail:c2#chase",
      waitingOnPersonId: sam.id,
      suggestedAction: "Ask Sam whether the contract is signed.",
      sourceSubject: "Re: Contract",
    });
    expect(t.sourceUrl).toContain("#all/contract");
    expect(t.waitingSince).not.toBeNull();
    expect(t.triagedAt).not.toBeNull();
    expect((await pendingNoReply()).map((i) => i.text)).toEqual(["Jo to book the venue"]);

    // The optional chase email: a follow-up drafted in the same thread, never sent.
    const d = await api(`tasks/${taskId}/reply-draft`, { body: {} });
    expect(d.status).toBe(200);
    expect(d.body).toMatchObject({ to: "Sam Lee <sam@client.com>", subject: "Re: Contract", canSaveToGmail: true });
    expect(draftCalls[0].chase).toBe(true);
    expect(draftCalls[0].thread.at(-1)!.fromOllie).toBe(true);
  });

  it("Already handled and Dropped keep it off the list, and a rerun does not bring it back", async () => {
    mixedSentMail();
    await scan();
    const items = await pendingNoReply();
    const r = await api("review/decide", { body: { ids: items.map((i) => i.id), action: "done" } });
    expect(r.status).toBe(200);
    expect(r.body.items.every((i: { state: string; taskId: number | null }) => i.state === "done" && i.taskId === null)).toBe(true);
    expect(await pendingNoReply()).toHaveLength(0);
    await scan();
    expect(await pendingNoReply()).toHaveLength(0);
  });

  it("each Gmail check closes answered emails and adds new sent ones straight away", async () => {
    mixedSentMail();
    await scan();
    expect((await pendingNoReply()).map((i) => i.text)).toEqual(["Jo to book the venue", "Sam to send the signed contract"]);

    // Sam answers; a new email goes out.
    threads.contract.push({ id: "c3", from: "Sam Lee <sam@client.com>", to: ME, subject: "Re: Contract", at: new Date(), text: "Signed copy attached." });
    threads.agenda = [{ id: "g1", from: ME, to: "Pat <pat@client.com>", subject: "Agenda", at: new Date(), text: "Could you send the agenda?" }];
    verdicts.Agenda = { ask: "Pat to send the agenda", reason: "You asked for the agenda.", chase: "Ask Pat for the agenda.", person: "Pat" };
    judged = [];

    const soon = new Date(Date.now() + 60_000);
    const first = await refreshNoReply(soon);
    expect(first).toMatchObject({ found: 1, answered: 1 });
    expect(judged.map((c) => c.subject)).toEqual(["Agenda"]);
    expect((await pendingNoReply()).map((i) => i.text).sort()).toEqual(["Jo to book the venue", "Pat to send the agenda"]);
    const [closed] = await db.select().from(reviewItemsTable).where(eq(reviewItemsTable.sourceRef, "gmail:c2"));
    expect(closed.state).toBe("answered");

    // Nothing changed: the next check reads nothing again.
    judged = [];
    const again = await refreshNoReply(new Date(soon.getTime() + 60_000));
    expect(again!.checked).toBe(0);
    expect(judged).toHaveLength(0);
  });

  it("a new email is expected back in 3 working days, turns due that day, and the date can be changed", async () => {
    mixedSentMail();
    verdicts.Pricing = { ask: "Lou to confirm the price", reason: "You asked Lou to confirm it.", chase: "Ask Lou about the price.", person: "Lou" };
    await scan();
    const items = await pendingNoReply();
    const lou = items.find((i) => i.text.startsWith("Lou"))!;
    expect(lou).toMatchObject({ expectedBy: expectedByDate(new Date()), due: false });
    expect(items.find((i) => i.text.startsWith("Sam"))).toMatchObject({ expectedBy: expectedByDate(ago(10)), due: true });
    expect((await api("review")).body).toMatchObject({ noReply: 3, noReplyDue: 2 });

    const r = await api(`review/${lou.id}/expected-by`, { method: "PUT", body: { date: todayLondon() } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ expectedBy: todayLondon(), due: true });
    expect((await api("review")).body.noReplyDue).toBe(3);
    expect((await api(`review/${lou.id}/expected-by`, { method: "PUT", body: { date: "next week" } })).status).toBe(400);
  });

  it("a Gmail check before any look through reads only the last day's sent email", async () => {
    mixedSentMail();
    const counts = await refreshNoReply();
    expect(counts).toMatchObject({ threads: 1, checked: 1 });
    expect(judged.map((c) => c.subject)).toEqual(["Pricing"]);
    const after = Number(/after:(\d+)/.exec(listQueries[0])![1]) * 1000;
    expect(Date.now() - after).toBeLessThan(DAY + 120_000);
  });

  it("can be stopped and resumed", async () => {
    mixedSentMail();
    // 25 threads, so the run reads two chunks.
    for (let i = 0; i < 15; i++) threads[`extra${i}`] = [{ id: `e${i}`, from: ME, to: "Al <al@client.com>", subject: `Extra ${i}`, at: ago(9), text: "Can you check this?" }];
    let open!: () => void;
    gate = new Promise((r) => (open = r));
    expect((await api("review/no-reply", { body: {} })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect((await api("review/no-reply", { body: {} })).status).toBe(400);
    const stopping = api("review/no-reply/stop", { body: {} });
    open();
    const stopped = (await stopping).body;
    expect(stopped.status).toBe("stopped");
    expect(stopped.done).toBe(20);
    expect(stopped.total).toBe(25);

    gate = null;
    expect((await api("review/no-reply/resume", { body: {} })).status).toBe(200);
    await waitForNoReplyScan();
    const done = (await api("review/no-reply")).body;
    expect(done).toMatchObject({ status: "done", done: 25, pending: 2 });
  });
});

describe("Email page, Drafts", () => {
  async function chasedWithDraft() {
    mixedSentMail();
    await scan();
    const item = (await pendingNoReply()).find((i) => i.text.startsWith("Sam"))!;
    const r = await api("review/decide", { body: { ids: [item.id], action: "waiting" } });
    const taskId = r.body.items[0].taskId as number;
    expect((await api(`tasks/${taskId}/reply-draft`, { body: {} })).status).toBe(200);
    return taskId;
  }
  const drafts = async () => {
    const r = await api("email/drafts");
    expect(r.status).toBe(200);
    return r.body.items as Record<string, any>[];
  };

  it("lists drafts still to go, and Done takes one off until a new draft is written", async () => {
    const taskId = await chasedWithDraft();
    const list = await drafts();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ chase: true, task: { id: taskId, status: "waiting" }, draft: { subject: "Re: Contract", sentAt: null } });

    expect((await api(`tasks/${taskId}/reply-draft/dismiss`, { body: {} })).status).toBe(200);
    expect(await drafts()).toHaveLength(0);
    // The draft stays on the task.
    expect((await api(`tasks/${taskId}/reply-draft`)).body.draft).not.toBeNull();

    expect((await api(`tasks/${taskId}/reply-draft`, { body: {} })).status).toBe(200);
    expect(await drafts()).toHaveLength(1);
  });

  it("a draft leaves the list once an email is sent in its thread after it, or its task closes", async () => {
    const taskId = await chasedWithDraft();
    await db.update(replyDraftsTable).set({ updatedAt: ago(1) }).where(eq(replyDraftsTable.taskId, taskId));

    // Nothing sent since the draft: it stays.
    expect(await checkSentDrafts()).toBe(0);
    expect(await drafts()).toHaveLength(1);

    threads.contract.push({ id: "c3", from: ME, to: "Sam Lee <sam@client.com>", subject: "Re: Contract", at: new Date(), text: "Just checking in on the contract." });
    expect(await checkSentDrafts()).toBe(1);
    expect(await drafts()).toHaveLength(0);
    const [row] = await db.select().from(replyDraftsTable).where(eq(replyDraftsTable.taskId, taskId));
    expect(row.sentAt).not.toBeNull();

    // A closed task takes its draft off too.
    expect((await api(`tasks/${taskId}/reply-draft`, { body: {} })).status).toBe(200);
    expect(await drafts()).toHaveLength(1);
    await db.update(tasksTable).set({ status: "done" }).where(eq(tasksTable.id, taskId));
    expect(await drafts()).toHaveLength(0);
  });

  it("a draft can be steered with what it should say, and changed from the current wording", async () => {
    const taskId = await chasedWithDraft();
    const r = await api(`tasks/${taskId}/reply-draft`, { body: { instructions: "Keep it light", current: "Hi Sam, any news?" } });
    expect(r.status).toBe(200);
    expect(draftCalls.at(-1)).toMatchObject({ instructions: "Keep it light", current: "Hi Sam, any news?" });
    expect((await api(`tasks/${taskId}/reply-draft`, { body: { other: 1 } })).status).toBe(400);
  });

  it("reads the thread behind an email task for the reading pane", async () => {
    const taskId = await chasedWithDraft();
    const r = await api(`tasks/${taskId}/thread`);
    expect(r.status).toBe(200);
    expect(r.body.fromGmail).toBe(true);
    expect(r.body.gmailUrl).toContain("#all/contract");
    expect(r.body.messages.map((m: Record<string, unknown>) => [m.fromOllie, m.fromName])).toEqual([[false, "Sam Lee"], [true, "Ollie Fisher"]]);
    expect(r.body.messages[1].text).toContain("signed copy");
  });
});
