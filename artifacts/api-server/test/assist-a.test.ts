/**
 * Assist, Part A: the Dropped status, "Probably noise" in the Inbox, and Draft reply saved to Gmail.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, noiseRulesTable, peopleTable, playbooksTable, replyDraftsTable, tasksTable } from "@workspace/db";
import type { GmailThread, OutgoingDraft } from "../src/services/connectors/gmail";
import type { NoiseCandidate, NoiseVerdict } from "../src/services/noiseJudge";
import type { AiDoc } from "../src/lib/ai-data/retrieve";
import { checkInboxNoise } from "../src/services/noiseCheck";
import { draftRaw } from "../src/services/connectors/gmail";
import { replyEnvelope } from "../src/services/replyDraft";
import { api, call, connect, mcp, useServer } from "./harness";
import { person, task } from "./helpers";

let judged: { items: NoiseCandidate[]; examples: { rules: string[]; noise: { title: string }[]; kept: { title: string }[] } }[] = [];
let verdicts: (items: NoiseCandidate[]) => NoiseVerdict[] = () => [];
vi.mock("../src/services/noiseJudge", () => ({
  judgeNoise: async (items: NoiseCandidate[], examples: never) => {
    judged.push({ items, examples });
    return verdicts(items);
  },
}));

let thread: GmailThread | null = null;
const saves: { threadId: string; draftId: string | null; draft: OutgoingDraft }[] = [];
vi.mock("../src/services/connectors/gmail", async (orig) => ({
  ...(await orig<typeof import("../src/services/connectors/gmail")>()),
  gmailThreadIdOf: async () => thread?.threadId ?? null,
  readGmailThread: async () => thread,
  saveGmailDraft: async (threadId: string, draftId: string | null, draft: OutgoingDraft) => {
    saves.push({ threadId, draftId, draft });
    return draftId ?? "draft-1";
  },
}));

let modelDocs: AiDoc[] = [];
let modelThread: { from: string; fromOllie: boolean; text: string }[] = [];
vi.mock("../src/services/ask/model", async (orig) => ({
  ...(await orig<typeof import("../src/services/ask/model")>()),
  draftEmailReplyFromDocs: async (opts: { docs: AiDoc[]; thread: { from: string; fromOllie: boolean; text: string }[] }) => {
    modelDocs = opts.docs;
    modelThread = opts.thread;
    return "Hi Sam,\n\nThursday works.\n\nBest, Ollie";
  },
}));

useServer();

async function inboxEmail(title: string, extra: Partial<typeof tasksTable.$inferInsert> = {}) {
  const [row] = await db
    .insert(tasksTable)
    .values({ title, status: "inbox", source: "email", createdBy: "test", capturedAt: new Date(), ...extra })
    .returning();
  return row;
}

describe("Dropped", () => {
  it("triage to Dropped leaves it out of open counts, then Restore and Undo bring it back", async () => {
    const t = await inboxEmail("Reply to the conference invite");
    const r = await api(`tasks/${t.id}/triage`, { body: { action: "dropped" } });
    expect(r.status).toBe(200);
    expect(r.body.task.status).toBe("dropped");

    const summary = (await api("tasks/summary")).body;
    expect(summary.tabs.dropped).toBe(1);
    expect(summary.tabs.open).toBe(0);
    expect(summary.stats.inboxToTriage).toBe(0);
    expect((await api("tasks?tab=dropped")).body.map((x: { id: number }) => x.id)).toEqual([t.id]);
    expect((await api("tasks")).body).toHaveLength(0);

    const undone = await api(`tasks/${t.id}/undo`, { body: {} });
    expect(undone.body.status).toBe("inbox");

    await api(`tasks/${t.id}/triage`, { body: { action: "dropped" } });
    const restored = await api(`tasks/${t.id}/restore`, { body: {} });
    expect(restored.body.status).toBe("inbox");
    const history = (await api(`tasks/${t.id}`)).body.history.map((h: { summary: string }) => h.summary);
    expect(history[0]).toBe("Restored from Dropped to Inbox");
  });

  it("can be set from the status dropdown, and Claude sees it as closed", async () => {
    const t = await task("Draft the board pack");
    expect((await api(`tasks/${t.id}`, { method: "PATCH", body: { status: "dropped" } })).body.status).toBe("dropped");

    const c = await mcp((await connect()).access_token);
    const open = await call(c, "list_tasks", {});
    expect(JSON.stringify(open.json)).not.toContain("Draft the board pack");
    const closed = await call(c, "list_tasks", { status: ["dropped"] });
    expect(JSON.stringify(closed.json)).toContain("Draft the board pack");
    const other = await task("Chase the venue");
    const set = await call(c, "update_task", { ref: `task:${other.id}`, status: "dropped" });
    expect(set.isError).toBeFalsy();
    const [row] = await db.select().from(tasksTable).where(eq(tasksTable.id, other.id));
    expect(row.status).toBe("dropped");
  });
});

describe("Probably noise", () => {
  it("flags likely noise with a reason, learns from rules, hand-moved noise and kept items, and Keep clears it", async () => {
    judged = [];
    await db.insert(noiseRulesTable).values({ matchType: "from_domain_equals", matchValue: "eventsmail.com" });
    await inboxEmail("Webinar invite", { status: "noise", fromName: "Events Co" });
    await inboxEmail("Partner intro", { noiseHintKept: true, noiseCheckedAt: new Date(), noiseHint: "Cold pitch" });
    const pitch = await inboxEmail("Book a demo of our CRM", { fromName: "Sales Rep", fromAddress: "rep@crm.example" });
    const real = await inboxEmail("Send the contract to Sam", { fromName: "Sam" });
    const hidden = await inboxEmail("Salary review notes", { confidential: true });
    verdicts = (items) => items.map((i) => ({ id: i.id, noise: i.id === pitch.id, reason: i.id === pitch.id ? "Cold sales email offering a demo" : "" }));

    const r = await checkInboxNoise();
    expect(r).toEqual({ checked: 3, flagged: 1 });
    expect(judged[0].items.map((i) => i.id).sort()).toEqual([pitch.id, real.id].sort());
    expect(judged[0].examples.rules).toHaveLength(1);
    expect(judged[0].examples.noise.map((x) => x.title)).toEqual(["Webinar invite"]);
    expect(judged[0].examples.kept.map((x) => x.title)).toEqual(["Partner intro"]);

    const inbox = (await api("tasks?tab=inbox")).body as { id: number; noiseHint: string | null }[];
    expect(inbox.find((t) => t.id === pitch.id)!.noiseHint).toBe("Cold sales email offering a demo");
    expect(inbox.find((t) => t.id === real.id)!.noiseHint).toBeNull();
    expect(inbox.find((t) => t.id === hidden.id)!.noiseHint).toBeNull();

    // A second check does not look at them again.
    judged = [];
    expect(await checkInboxNoise()).toEqual({ checked: 0, flagged: 0 });
    expect(judged).toHaveLength(0);

    const kept = await api(`tasks/${pitch.id}/keep`, { body: {} });
    expect(kept.status).toBe(200);
    expect(kept.body.noiseHint).toBeNull();
    expect(kept.body.status).toBe("inbox");
  });

  it("moved to Noise and restored, it no longer shows as probably noise", async () => {
    const t = await inboxEmail("Survey about our service", { noiseHint: "Company survey", noiseCheckedAt: new Date() });
    await api(`tasks/${t.id}/triage`, { body: { action: "noise" } });
    const back = await api(`tasks/${t.id}/restore`, { body: {} });
    expect(back.body.noiseHint).toBeNull();
  });
});

describe("Draft reply", () => {
  const sam = { name: "Sam Lee", email: "sam@client.example" };
  const me = { name: "Ollie Fisher", email: "ollie@example.com" };
  const msg = (o: { id: string; from: typeof sam; to: (typeof sam)[]; cc?: (typeof sam)[]; text: string; at: string; subject?: string }) => ({
    id: o.id,
    at: new Date(o.at),
    from: o.from,
    to: o.to,
    cc: o.cc ?? [],
    replyTo: [],
    subject: o.subject ?? "Workshop dates",
    messageId: `<${o.id}@mail>`,
    references: null,
    text: o.text,
  });

  it("drafts from the thread and OllieOS, saves into the right Gmail thread, and never sends", async () => {
    const p = await person("Sam Lee");
    await db.update(peopleTable).set({ email: sam.email }).where(eq(peopleTable.id, p.id));
    await db.insert(playbooksTable).values({ title: "Sign-off", appliesWhen: "Any email", rule: "Sign off with Best, Ollie" });
    const t = await inboxEmail("Confirm workshop date with Sam", {
      fromName: sam.name,
      fromAddress: sam.email,
      sourceRef: "gmail:m2",
      sourceUrl: "https://mail.google.com/mail/?authuser=ollie%40example.com#all/thread123456",
    });
    thread = {
      account: me.email,
      threadId: "thread123456",
      messages: [
        msg({ id: "m1", from: me, to: [sam], text: "Shall we do a workshop?", at: "2026-11-09T09:00:00Z" }),
        msg({ id: "m2", from: sam, to: [me], cc: [{ name: "Amy", email: "amy@client.example" }], text: "Is Thursday OK?", at: "2026-11-10T09:00:00Z", subject: "Re: Workshop dates" }),
      ],
    };

    expect((await api(`tasks/${t.id}/reply-draft`)).body).toEqual({ draft: null });
    const w = await api(`tasks/${t.id}/reply-draft`, { body: {} });
    expect(w.status).toBe(200);
    expect(w.body).toMatchObject({ to: "Sam Lee <sam@client.example>", cc: "Amy <amy@client.example>", subject: "Re: Workshop dates", canSaveToGmail: true, savedAt: null, gmailUrl: null });
    expect(w.body.body).toContain("Thursday works.");
    expect(modelThread.map((m) => m.fromOllie)).toEqual([true, false]);
    const refs = modelDocs.map((d) => d.ref);
    expect(refs).toContain(`task:${t.id}`);
    expect(refs).toContain(`person:${p.id}`);
    expect(modelDocs.some((d) => d.text.includes("Sign off with Best, Ollie"))).toBe(true);

    const edited = { to: w.body.to, cc: "", subject: w.body.subject, body: "Hi Sam,\n\nThursday at 10 works.\n\nBest, Ollie" };
    const s1 = await api(`tasks/${t.id}/reply-draft/gmail`, { body: edited });
    expect(s1.status).toBe(200);
    expect(s1.body.savedAt).not.toBeNull();
    expect(s1.body.gmailUrl).toContain("#all/thread123456");
    expect(saves[0]).toMatchObject({ threadId: "thread123456", draftId: null });
    expect(saves[0].draft.inReplyTo).toBe("<m2@mail>");

    // Saving again updates the same Gmail draft.
    await api(`tasks/${t.id}/reply-draft/gmail`, { body: { ...edited, body: edited.body + "\n" } });
    expect(saves[1].draftId).toBe("draft-1");
    const [row] = await db.select().from(replyDraftsTable).where(eq(replyDraftsTable.taskId, t.id));
    expect(row.gmailDraftId).toBe("draft-1");
  });

  it("refuses when the email is hidden from AI, and falls back to copy only without a Gmail thread", async () => {
    thread = null;
    const hidden = await inboxEmail("Private email", { confidential: true, fromAddress: "x@y.example" });
    const r = await api(`tasks/${hidden.id}/reply-draft`, { body: {} });
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("hidden from AI");

    const loose = await inboxEmail("Reply to Jo", { fromName: "Jo", fromAddress: "jo@x.example", sourceSubject: "Lunch", sourceQuote: "Lunch on Friday?" });
    const d = await api(`tasks/${loose.id}/reply-draft`, { body: {} });
    expect(d.body).toMatchObject({ to: "Jo <jo@x.example>", subject: "Re: Lunch", canSaveToGmail: false });
    const s = await api(`tasks/${loose.id}/reply-draft/gmail`, { body: { to: d.body.to, cc: "", subject: "Re: Lunch", body: "Yes" } });
    expect(s.status).toBe(409);

    const manual = await task("Not an email");
    expect((await api(`tasks/${manual.id}/reply-draft`, { body: {} })).status).toBe(409);
  });

  it("builds a threaded reply message without sending", () => {
    const raw = Buffer.from(
      draftRaw({ to: "Sam <sam@x.example>", cc: "", subject: "Re: Café plans", body: "Hi Sam,\nYes.", inReplyTo: "<a@b>", references: "<z@b>" }),
      "base64url",
    ).toString("utf8");
    expect(raw).toContain("To: Sam <sam@x.example>");
    expect(raw).toContain("Subject: =?UTF-8?B?");
    expect(raw).toContain("In-Reply-To: <a@b>");
    expect(raw).toContain("References: <z@b> <a@b>");
    expect(raw).not.toMatch(/^Cc:/m);
  });

  it("replies to the latest message from someone else, without Ollie in the recipients", () => {
    const env = replyEnvelope(
      {
        account: "ollie@example.com",
        threadId: "t",
        messages: [
          msg({ id: "a", from: sam, to: [me, { name: "Amy", email: "amy@x.example" }], text: "Hi", at: "2026-11-09T09:00:00Z" }),
        ],
      },
      null,
    );
    expect(env.to.map((a) => a.email)).toEqual(["sam@client.example"]);
    expect(env.cc.map((a) => a.email)).toEqual(["amy@x.example"]);
    expect(env.subject).toBe("Re: Workshop dates");
  });
});
