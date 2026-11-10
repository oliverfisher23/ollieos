/**
 * Part J: Email. Brief a reply (written in the background, saved to Gmail as a draft, never sent),
 * a sent reply marking its email done, the "How you write" note, thread summaries, and saving
 * attachments to the Library.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, documentContentsTable, documentsTable, knowledgeSourcesTable, replyDraftsTable, tasksTable } from "@workspace/db";
import { checkSentDrafts } from "../src/services/email";
import { waitForBriefedDrafts } from "../src/services/replyDraft";
import { waitForWritingStyle } from "../src/services/writingStyle";
import { api, OLLIE, useServer } from "./harness";

/* ---------- A fake Gmail behind the connector proxy ---------- */

interface FakeFile {
  partId: string;
  filename: string;
  mimeType: string;
  text: string;
}
interface FakeMessage {
  id: string;
  from: string;
  to: string;
  subject: string;
  at: Date;
  text: string;
  labels?: string[];
  headers?: Record<string, string>;
  files?: FakeFile[];
}

let threads: Record<string, FakeMessage[]> = {};
let gmailWrites: { method: string; path: string }[] = [];

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");

function gmailMessage(threadId: string, m: FakeMessage) {
  const headers = [
    { name: "From", value: m.from },
    { name: "To", value: m.to },
    { name: "Subject", value: m.subject },
    { name: "Message-ID", value: `<${m.id}@mail>` },
    ...Object.entries(m.headers ?? {}).map(([name, value]) => ({ name, value })),
  ];
  const text = { partId: "0", mimeType: "text/plain", body: { data: b64(m.text), size: m.text.length } };
  const payload = m.files?.length
    ? {
        mimeType: "multipart/mixed",
        headers,
        body: { size: 0 },
        parts: [text, ...m.files.map((f) => ({ partId: f.partId, filename: f.filename, mimeType: f.mimeType, body: { attachmentId: `att-${m.id}-${f.partId}`, size: f.text.length } }))],
      }
    : { mimeType: "text/plain", headers, body: { data: b64(m.text) } };
  return {
    id: m.id,
    threadId,
    labelIds: m.labels ?? (m.from.includes(OLLIE) ? ["SENT"] : ["INBOX"]),
    internalDate: String(m.at.getTime()),
    snippet: m.text.slice(0, 150),
    payload,
  };
}

const findMessage = (id: string) => {
  for (const [threadId, msgs] of Object.entries(threads)) {
    const m = msgs.find((x) => x.id === id);
    if (m) return { threadId, m };
  }
  return null;
};

vi.mock("../src/services/connectors/http", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/connectors/http")>();
  const json = (path: string): Record<string, unknown> | null => {
    const url = new URL("https://x" + path);
    if (url.pathname === "/gmail/v1/users/me/profile") return { emailAddress: OLLIE };
    if (url.pathname === "/gmail/v1/users/me/messages") {
      // Sent mail, for How you write.
      const ids = Object.values(threads).flat().filter((m) => m.from.includes(OLLIE)).map((m) => ({ id: m.id }));
      return { messages: ids };
    }
    const att = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname);
    if (att) {
      const hit = findMessage(decodeURIComponent(att[1]));
      const f = hit?.m.files?.find((x) => `att-${hit.m.id}-${x.partId}` === decodeURIComponent(att[2]));
      return f ? { data: b64(f.text), size: f.text.length } : null;
    }
    const msg = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(url.pathname);
    if (msg) {
      const hit = findMessage(decodeURIComponent(msg[1]));
      return hit ? gmailMessage(hit.threadId, hit.m) : null;
    }
    const t = /^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/.exec(url.pathname);
    if (t) {
      const id = decodeURIComponent(t[1]);
      const msgs = threads[id];
      return msgs ? { id, messages: msgs.map((m) => gmailMessage(id, m)) } : null;
    }
    if (url.pathname === "/gmail/v1/users/me/threads") return { threads: [] };
    throw new Error("Unexpected path " + path);
  };
  return {
    ...real,
    proxyJson: async (_c: string, _n: string, path: string) => json(path) ?? {},
    proxyJsonOrNull: async (_c: string, _n: string, path: string) => json(path),
    proxyWriteJson: async (_c: string, _n: string, method: string, path: string) => {
      gmailWrites.push({ method, path });
      return { id: "draft-1" };
    },
  };
});

/* ---------- Fake AI ---------- */

let draftCalls: { instructions?: string; style?: string | null }[] = [];
let draftFails = false;
let draftGate: Promise<void> | null = null;
vi.mock("../src/services/ask/model", async (orig) => ({
  ...(await orig<typeof import("../src/services/ask/model")>()),
  draftEmailReplyFromDocs: async (opts: { instructions?: string; style?: string | null }) => {
    if (draftGate) await draftGate;
    draftCalls.push(opts);
    if (draftFails) throw new Error("model down");
    return "Hi Sam,\n\nYes, Tuesday works.\n\nOllie";
  },
}));

let haikuCalls: string[] = [];
let modelCalls: string[] = [];
vi.mock("../src/services/connectors/sorter", async (orig) => ({
  ...(await orig<typeof import("../src/services/connectors/sorter")>()),
  haikuJson: async (_system: string, content: string) => {
    haikuCalls.push(content);
    return { summary: "- Sam asked about Tuesday\n- You still owe the budget" };
  },
  modelJson: async (_model: string, _system: string, content: string) => {
    modelCalls.push(content);
    return { note: "- Open with the person's first name\n- Sign off with just Ollie" };
  },
}));

useServer();

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const ME = `Ollie Fisher <${OLLIE}>`;
const SAM = "Sam Lee <sam@client.com>";

beforeEach(() => {
  threads = {};
  gmailWrites = [];
  draftCalls = [];
  draftFails = false;
  draftGate = null;
  haikuCalls = [];
  modelCalls = [];
});

async function emailTask(threadId: string, lastId: string, opts: { confidential?: boolean; status?: "inbox" | "now" } = {}) {
  const [t] = await db
    .insert(tasksTable)
    .values({
      title: "Answer Sam about Tuesday",
      status: opts.status ?? "inbox",
      source: "email",
      sourceRef: `gmail:${lastId}`,
      sourceUrl: `https://mail.google.com/mail/#all/${threadId}`,
      sourceSubject: "Tuesday",
      fromName: "Sam Lee",
      fromAddress: "sam@client.com",
      confidential: opts.confidential ?? null,
      createdBy: "ollieos",
    })
    .returning();
  return t;
}

const sentText = (n: number) =>
  `Hi there, thanks for sending this over. I have had a look and I think we should go ahead with the plan as it stands, number ${n}. Could you let me know when the next step is booked so I can tell the team? Ollie`;

describe("Brief a reply", () => {
  it("moves the email to Drafts as Writing, writes it in the background, and saves it to Gmail", async () => {
    threads.tue = [{ id: "m1", from: SAM, to: ME, subject: "Tuesday", at: ago(1), text: "Can we meet on Tuesday?" }];
    const t = await emailTask("tue", "m1");
    let open!: () => void;
    draftGate = new Promise((r) => (open = r));

    const r = await api(`tasks/${t.id}/reply-draft/brief`, { body: { brief: "  yes to Tuesday,   ask for the budget " } });
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ state: "writing", brief: "yes to Tuesday, ask for the budget", body: "" });
    const list = (await api("email/drafts")).body.items as Record<string, any>[];
    expect(list.map((d) => [d.task.id, d.draft.state])).toEqual([[t.id, "writing"]]);
    // Briefing twice while it is still being written is refused.
    expect((await api(`tasks/${t.id}/reply-draft/brief`, { body: { brief: "no" } })).status).toBe(409);

    open();
    await waitForBriefedDrafts();
    expect(draftCalls[0].instructions).toBe("yes to Tuesday, ask for the budget");
    const d = (await api(`tasks/${t.id}/reply-draft`)).body.draft;
    expect(d).toMatchObject({ state: "ready", error: null, brief: "yes to Tuesday, ask for the budget", subject: "Re: Tuesday", to: SAM });
    expect(d.body).toContain("Tuesday works");
    expect(d.savedAt).not.toBeNull();
    // Saved as a Gmail draft, never sent.
    expect(gmailWrites).toEqual([{ method: "POST", path: "/gmail/v1/users/me/drafts" }]);
  });

  it("shows a failed draft with its error, and it can be tried again", async () => {
    threads.tue = [{ id: "m1", from: SAM, to: ME, subject: "Tuesday", at: ago(1), text: "Can we meet on Tuesday?" }];
    const t = await emailTask("tue", "m1");
    draftFails = true;
    await api(`tasks/${t.id}/reply-draft/brief`, { body: { brief: "yes" } });
    await waitForBriefedDrafts();
    const failed = (await api(`tasks/${t.id}/reply-draft`)).body.draft;
    expect(failed.state).toBe("failed");
    expect(failed.error).toMatch(/could not be written/);
    expect(gmailWrites).toHaveLength(0);

    draftFails = false;
    expect((await api(`tasks/${t.id}/reply-draft/brief`, { body: { brief: "yes" } })).status).toBe(202);
    await waitForBriefedDrafts();
    expect((await api(`tasks/${t.id}/reply-draft`)).body.draft.state).toBe("ready");
  });

  it("a writing draft that never finished shows as failed", async () => {
    threads.tue = [{ id: "m1", from: SAM, to: ME, subject: "Tuesday", at: ago(1), text: "Can we meet on Tuesday?" }];
    const t = await emailTask("tue", "m1");
    await db.insert(replyDraftsTable).values({ taskId: t.id, body: "", brief: "yes", state: "writing", updatedAt: new Date(Date.now() - 11 * 60_000) });
    const d = (await api(`tasks/${t.id}/reply-draft`)).body.draft;
    expect(d.state).toBe("failed");
    // And it can be briefed again.
    expect((await api(`tasks/${t.id}/reply-draft/brief`, { body: { brief: "yes" } })).status).toBe(202);
    await waitForBriefedDrafts();
  });

  it("checks the brief and refuses emails hidden from AI", async () => {
    threads.tue = [{ id: "m1", from: SAM, to: ME, subject: "Tuesday", at: ago(1), text: "Can we meet on Tuesday?" }];
    const t = await emailTask("tue", "m1");
    expect((await api(`tasks/${t.id}/reply-draft/brief`, { body: { brief: "" } })).status).toBe(400);
    expect((await api(`tasks/${t.id}/reply-draft/brief`, { body: { brief: "x".repeat(501) } })).status).toBe(400);
    threads.sec = [{ id: "x1", from: SAM, to: ME, subject: "Pay", at: ago(1), text: "About pay." }];
    const secret = await emailTask("sec", "x1", { confidential: true });
    expect((await api(`tasks/${secret.id}/reply-draft/brief`, { body: { brief: "yes" } })).status).toBe(409);
    expect(draftCalls).toHaveLength(0);
  });

  it("a reply sent from Gmail marks the email done", async () => {
    threads.tue = [{ id: "m1", from: SAM, to: ME, subject: "Tuesday", at: ago(1), text: "Can we meet on Tuesday?" }];
    const t = await emailTask("tue", "m1", { status: "now" });
    await api(`tasks/${t.id}/reply-draft/brief`, { body: { brief: "yes" } });
    await waitForBriefedDrafts();
    await db.update(replyDraftsTable).set({ updatedAt: ago(0.5) }).where(eq(replyDraftsTable.taskId, t.id));
    threads.tue.push({ id: "m2", from: ME, to: SAM, subject: "Re: Tuesday", at: new Date(), text: "Yes, Tuesday works." });
    expect(await checkSentDrafts()).toBe(1);
    const [after] = await db.select().from(tasksTable).where(eq(tasksTable.id, t.id));
    expect(after.status).toBe("done");
    expect((await api("email/drafts")).body.items).toHaveLength(0);
  });
});

describe("How you write", () => {
  it("is read from sent email, leaving out invites, forwards and short notes, and used in every draft", async () => {
    expect((await api("email/style")).body).toMatchObject({ note: null, status: "idle" });
    threads.sent = [
      ...[1, 2, 3, 4, 5, 6].map((n) => ({ id: `s${n}`, from: ME, to: SAM, subject: `Plan ${n}`, at: ago(n), text: sentText(n) })),
      { id: "s7", from: ME, to: SAM, subject: "Fwd: Plan", at: ago(2), text: sentText(7) },
      { id: "s8", from: ME, to: SAM, subject: "Accepted: Planning", at: ago(2), text: sentText(8) },
      { id: "s9", from: ME, to: SAM, subject: "Quick", at: ago(2), text: "Thanks, will do." },
    ];
    const r = await api("email/style/read", { body: {} });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe("reading");
    await waitForWritingStyle();
    const s = (await api("email/style")).body;
    expect(s).toMatchObject({ status: "ready", emails: 6, editedAt: null, error: null });
    expect(s.note).toContain("Sign off with just Ollie");
    expect(modelCalls[0]).toContain("number 6");
    expect(modelCalls[0]).not.toContain("number 7");
    expect(modelCalls[0]).not.toContain("number 8");

    const edited = await api("email/style", { method: "PUT", body: { note: "- Keep it short" } });
    expect(edited.status).toBe(200);
    expect(edited.body.note).toBe("- Keep it short");
    expect(edited.body.editedAt).not.toBeNull();
    expect((await api("email/style", { method: "PUT", body: { note: "x".repeat(4001) } })).status).toBe(400);

    // Drafts follow it.
    threads.tue = [{ id: "m1", from: SAM, to: ME, subject: "Tuesday", at: ago(1), text: "Can we meet on Tuesday?" }];
    const t = await emailTask("tue", "m1");
    expect((await api(`tasks/${t.id}/reply-draft`, { body: {} })).status).toBe(200);
    expect(draftCalls.at(-1)!.style).toBe("- Keep it short");
  });

  it("says so when there is too little sent email to learn from", async () => {
    threads.sent = [{ id: "s1", from: ME, to: SAM, subject: "Plan", at: ago(1), text: sentText(1) }];
    await api("email/style/read", { body: {} });
    await waitForWritingStyle();
    const s = (await api("email/style")).body;
    expect(s.status).toBe("failed");
    expect(s.error).toMatch(/not enough sent email/);
    expect(modelCalls).toHaveLength(0);
  });
});

describe("Thread summaries", () => {
  const msg = (n: number, fromSam = n % 2 === 1): FakeMessage => ({
    id: `m${n}`,
    from: fromSam ? SAM : ME,
    to: fromSam ? ME : SAM,
    subject: "Tuesday",
    at: ago(10 - n),
    text: `Message ${n} about Tuesday.`,
  });

  it("only long threads get one; it is kept until a new message arrives", async () => {
    threads.tue = [msg(1), msg(2), msg(3)];
    const t = await emailTask("tue", "m3");
    expect((await api(`tasks/${t.id}/thread/summary`)).body).toMatchObject({ summary: null, messages: 3, why: "short" });
    expect(haikuCalls).toHaveLength(0);

    threads.tue.push(msg(4));
    const first = await api(`tasks/${t.id}/thread/summary`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ messages: 4, why: null });
    expect(first.body.summary).toContain("You still owe the budget");
    expect(haikuCalls[0]).toContain('from="Ollie"');
    expect(haikuCalls[0]).toContain("Message 1 about Tuesday");

    await api(`tasks/${t.id}/thread/summary`);
    expect(haikuCalls).toHaveLength(1);

    threads.tue.push(msg(5));
    expect((await api(`tasks/${t.id}/thread/summary`)).body.messages).toBe(5);
    expect(haikuCalls).toHaveLength(2);
  });

  it("is not written for emails hidden from AI", async () => {
    threads.tue = [msg(1), msg(2), msg(3), msg(4)];
    const t = await emailTask("tue", "m4", { confidential: true });
    expect((await api(`tasks/${t.id}/thread/summary`)).body).toMatchObject({ summary: null, why: "hidden" });
    expect(haikuCalls).toHaveLength(0);
  });
});

describe("Attachments", () => {
  function withFiles() {
    threads.tue = [
      {
        id: "m1",
        from: SAM,
        to: ME,
        subject: "Tuesday",
        at: ago(1),
        text: "Agenda attached.",
        files: [
          { partId: "1", filename: "Agenda notes.txt", mimeType: "text/plain", text: "Item one: the budget. Item two: the venue." },
          { partId: "2", filename: "photos.zip", mimeType: "application/zip", text: "zip" },
        ],
      },
    ];
  }

  it("lists them on the message, saves a readable one to the Library, and queues it to be read", async () => {
    withFiles();
    const t = await emailTask("tue", "m1", { confidential: true });
    const thread = (await api(`tasks/${t.id}/thread`)).body;
    expect(thread.messages[0].attachments).toEqual([
      { partId: "1", filename: "Agenda notes.txt", size: 42, canSave: true, documentId: null },
      { partId: "2", filename: "photos.zip", size: 3, canSave: false, documentId: null },
    ]);

    const r = await api(`tasks/${t.id}/thread/attachments`, { body: { messageId: "m1", partId: "1" } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ title: "Agenda notes", url: null, confidential: true, textOrigin: "email" });
    expect(r.body.summary).toContain('"Tuesday" from Sam Lee');
    const [kept] = await db.select().from(documentContentsTable).where(eq(documentContentsTable.documentId, r.body.id));
    expect(kept).toMatchObject({ origin: "email", fileId: "gmail:tue/m1/1", originName: "Agenda notes.txt" });
    expect(kept.text).toContain("the venue");
    const queued = await db.select().from(knowledgeSourcesTable).where(and(eq(knowledgeSourcesTable.documentId, r.body.id), eq(knowledgeSourcesTable.status, "queued")));
    expect(queued).toHaveLength(1);

    // Saved once; the thread shows where it went.
    expect((await api(`tasks/${t.id}/thread/attachments`, { body: { messageId: "m1", partId: "1" } })).status).toBe(409);
    expect((await api(`tasks/${t.id}/thread`)).body.messages[0].attachments[0].documentId).toBe(r.body.id);
    expect(await db.select().from(documentsTable)).toHaveLength(1);
  });

  it("refuses files it cannot read, and attachments from another email", async () => {
    withFiles();
    threads.other = [{ id: "o1", from: SAM, to: ME, subject: "Other", at: ago(1), text: "x", files: [{ partId: "1", filename: "x.txt", mimeType: "text/plain", text: "secret" }] }];
    const t = await emailTask("tue", "m1");
    expect((await api(`tasks/${t.id}/thread/attachments`, { body: { messageId: "m1", partId: "2" } })).status).toBe(400);
    expect((await api(`tasks/${t.id}/thread/attachments`, { body: { messageId: "o1", partId: "1" } })).status).toBe(404);
    expect((await api(`tasks/${t.id}/thread/attachments`, { body: { messageId: "m1", partId: "9" } })).status).toBe(404);
    expect(await db.select().from(documentsTable)).toHaveLength(0);
  });
});
