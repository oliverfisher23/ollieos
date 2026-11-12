/**
 * Build plan section 24: lessons for the readers. The reader coach learns from Inbox items Ollie
 * undid or changed, the card coach from cards he rejected. A lesson needs three corrections, never
 * carries anything hidden from AI, and only reaches a reader once he turns it on. The model is stood
 * in at recordedCreate, so the real prompts are built and the real answers parsed.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditEventsTable, db, evalCasesTable, evalReplaysTable, readerLessonsTable, suggestionsTable, tasksTable } from "@workspace/db";
import type { AgentKey } from "../src/lib/agents";
import { propose } from "../src/services/suggestions";
import { coach, learnLessons, learnLessonsIfDue, lessonsFor, MAX_ON, setLessonStatus, tryLesson } from "../src/services/readerLessons";
import { sortAndCapture } from "../src/services/connectors/capture";
import type { WorkUnit } from "../src/services/connectors/messages";
import { scorecards } from "../src/services/scorecards";
import { api, useServer } from "./harness";
import { organisation } from "./helpers";

type Call = { agent: AgentKey; system: string; content: string };
const calls: Call[] = [];
const answers: Partial<Record<AgentKey, (c: Call) => unknown>> = {};

vi.mock("../src/lib/aiRuns", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/aiRuns")>()),
  recordedCreate: async (agent: AgentKey, params: { system: string; messages: { content: string }[] }) => {
    const c = { agent, system: String(params.system), content: String(params.messages[0].content) };
    calls.push(c);
    const answer = answers[agent];
    if (!answer) throw new Error(`No stand-in answer for ${agent}`);
    return { content: [{ type: "text", text: JSON.stringify(answer(c)) }], usage: {} };
  },
}));

useServer();

const reset = () => {
  calls.length = 0;
  for (const k of Object.keys(answers)) delete answers[k as AgentKey];
};

/** An Inbox item the Gmail reader made. */
async function made(title: string, status: string, extra: Partial<typeof tasksTable.$inferInsert> = {}) {
  const [t] = await db
    .insert(tasksTable)
    .values({ title, status: status as never, source: "email", sourceRef: `gmail:${Math.random().toString(36).slice(2)}`, fromName: "Calendar", sourceSubject: title, createdBy: "ollieos", ...extra })
    .returning();
  return t;
}

const refsIn = (content: string, prefix: string) => [...content.matchAll(new RegExp(`\\[(${prefix}\\d+)\\]`, "g"))].map((m) => m[1]);
const lesson = (text: string, evidence: string[], why = "You kept sending these to Noise") => ({ reasoning: "A pattern", propose: true, text, why, evidence });

describe("Reader coach", () => {
  it("proposes a lesson only with three real corrections behind it, and never reads anything hidden from AI", async () => {
    reset();
    for (const d of ["Monday", "Tuesday", "Wednesday", "Thursday"]) await made(`Accepted: Weekly sync ${d}`, "noise");
    await made("Accepted: Board meeting about the sale", "noise", { confidential: true });
    const renamed = await made("Reply to Sam", "now");
    await db.insert(auditEventsTable).values({ actor: "ollie", action: "update", entityType: "task", entityId: renamed.id, payload: { changes: [{ field: "title", from: "Reply to Sam", to: "Send Sam the Q3 numbers" }] } });
    await made("Review the Acme proposal", "done");

    answers.reader_coach = (c) => {
      const undone = refsIn(c.content, "u");
      return {
        lessons: [
          lesson("Do not make tasks from automatic calendar acceptances — they need nothing from Ollie.", undone),
          lesson("Something with too little behind it", undone.slice(0, 2)),
          lesson("Name the person in the title", ["k999", "u1", "e1"]),
        ],
      };
    };
    const r = await coach("gmail_sorter", "tasks");
    expect(r).toMatchObject({ corrections: 5, proposed: 1 });
    const shown = calls[0].content;
    expect(shown).toContain("Accepted: Weekly sync Monday");
    expect(shown).toContain('You changed the title from "Reply to Sam" to "Send Sam the Q3 numbers"');
    expect(shown).toContain("Review the Acme proposal");
    expect(shown).not.toContain("sale");
    const [l] = await db.select().from(readerLessonsTable);
    expect(l).toMatchObject({ reader: "gmail_sorter", about: "tasks", status: "proposed", evidence: 4, learnedBy: "reader_coach", text: "Do not make tasks from automatic calendar acceptances, they need nothing from Ollie." });
    expect(l.examples).toHaveLength(3);

    // Proposed lessons do nothing yet.
    expect(await lessonsFor("gmail_sorter")).toEqual([]);

    // The same lesson again is not proposed twice; a reader with too few corrections calls no model.
    calls.length = 0;
    expect((await coach("gmail_sorter", "tasks")).proposed).toBe(0);
    expect(await coach("slack_sorter", "tasks")).toMatchObject({ corrections: 0, proposed: 0, skipped: expect.any(String) });
    expect(calls.map((c) => c.agent)).toEqual(["reader_coach"]);
  });

  it("goes into the reader's instructions once turned on, and comes out again when turned off", async () => {
    reset();
    const [l] = await db
      .insert(readerLessonsTable)
      .values({ reader: "gmail_sorter", about: "tasks", text: "Never make tasks from calendar acceptances.", normalisedText: "x", why: "w", evidence: 4, learnedBy: "reader_coach" })
      .returning();
    const [k] = await db
      .insert(readerLessonsTable)
      .values({ reader: "gmail_sorter", about: "knowledge", text: "Never propose meeting times as facts.", normalisedText: "y", why: "w", evidence: 3, learnedBy: "card_coach" })
      .returning();
    const unit: WorkUnit = {
      source: "email",
      key: "gmail:t1",
      subject: "Hello",
      channel: null,
      people: [{ name: "Sam Lee", email: "sam@acme.com" }],
      messages: [{ ref: "gmail:t1", at: new Date(), fromMe: false, fromName: "Sam Lee", fromAddress: "sam@acme.com", text: "Hi", url: "https://mail.google.com/mail/#all/t1" }],
    };
    const blank = { summary: "", project: "", items: [], knowledge: [], reply_needed: "none", reply_ask: "", progress: [], signature_title: "", signature_company: "", signature_phone: "", ideas: [] };
    answers.gmail_sorter = () => ({ results: [{ unit: "u1", ...blank }] });

    await sortAndCapture([unit], { me: "", now: new Date(), agent: "gmail_sorter" });
    expect(calls[0].system).not.toContain("Lessons from Ollie's corrections");

    await api(`lessons/${l.id}`, { method: "PATCH", body: { status: "on" } });
    await api(`lessons/${k.id}`, { method: "PATCH", body: { status: "on" } });
    await sortAndCapture([unit], { me: "", now: new Date(), agent: "gmail_sorter" });
    expect(calls[1].system).toContain("- Items: Never make tasks from calendar acceptances.");
    expect(calls[1].system).toContain("- Knowledge: Never propose meeting times as facts.");
    // Only the Gmail reader's lessons: the Slack reader has none.
    expect(await lessonsFor("slack_sorter")).toEqual([]);

    await setLessonStatus(l.id, "off");
    await sortAndCapture([unit], { me: "", now: new Date(), agent: "gmail_sorter" });
    expect(calls[2].system).not.toContain("calendar acceptances");

    // Only a proposed lesson can be turned down; and a reader has at most MAX_ON on.
    await expect(setLessonStatus(k.id, "rejected")).rejects.toThrow(/Turn this one off/);
    for (let i = 0; i < MAX_ON - 1; i++) {
      await db.insert(readerLessonsTable).values({ reader: "gmail_sorter", about: "tasks", text: `Lesson ${i}`, normalisedText: `l${i}`, why: "w", evidence: 3, learnedBy: "reader_coach", status: "on" });
    }
    const over = await api(`lessons/${l.id}`, { method: "PATCH", body: { status: "on" } });
    expect(over.status).toBe(400);
  });

  it("tries a lesson against the test cases with and without it, recording nothing on the cases", async () => {
    reset();
    const unit: WorkUnit = {
      source: "email",
      key: "gmail:c1",
      subject: "Accepted: Weekly sync",
      channel: null,
      people: [],
      messages: [{ ref: "gmail:c1", at: new Date(), fromMe: false, fromName: "Calendar", fromAddress: "calendar@google.com", text: "Accepted", url: "https://mail.google.com/mail/#all/c1" }],
    };
    const [c] = await db.insert(evalCasesTable).values({ agent: "gmail_sorter", title: "Accepted: Weekly sync", unit, me: "", expected: "no_task", gotThen: [] }).returning();
    const [l] = await db
      .insert(readerLessonsTable)
      .values({ reader: "gmail_sorter", about: "tasks", text: "Never make tasks from calendar acceptances.", normalisedText: "x", why: "w", evidence: 4, learnedBy: "reader_coach" })
      .returning();
    const item = { ref: "gmail:c1", type: "task", title: "Go to the weekly sync", action: "", priority: "medium", due: "", project: "", person: "", quote: "Accepted", confidential: false };
    // The stand-in reader makes a task unless the lesson is in its instructions.
    answers.test_replay = (call) => ({ results: [{ unit: "u1", summary: "", project: "", items: call.system.includes("calendar acceptances") ? [] : [item], knowledge: [], reply_needed: "none", reply_ask: "", progress: [], signature_title: "", signature_company: "", signature_phone: "", ideas: [] }] });

    const tried = await api(`lessons/${l.id}/try`, { method: "POST" });
    expect(tried.body.lastTry).toMatchObject({ passed: 1, total: 1, without: 0 });
    expect((await db.select().from(evalCasesTable).where(eq(evalCasesTable.id, c.id)))[0].lastResult).toBeNull();
    expect(await db.select().from(evalReplaysTable)).toHaveLength(0);

    // Once on, ordinary replays include it.
    await setLessonStatus(l.id, "on");
    const replayed = await api("evals/replay", { method: "POST", body: { agent: "gmail_sorter" } });
    expect(replayed.body).toMatchObject({ passed: 1, total: 1 });
  });
});

describe("Card coach", () => {
  it("learns from cards Ollie rejected, never from hidden ones, and a lesson he said no to is not proposed again", async () => {
    reset();
    const acme = await organisation("Acme");
    const secret = await organisation("Buyer Co", { confidential: true });
    const meta = { proposedBy: "Gmail check", clientId: null, sourceType: "email" };
    const card = async (orgId: number, text: string) =>
      ((await propose(meta, { kind: "fact", entityType: "organisation", entityId: orgId, payload: { text, attribute: null, supersedes: null, source: null } })) as { suggestionId: number }).suggestionId;
    const rejectIds = [
      await card(acme.id, "The Acme call moved to 3pm on Tuesday"),
      await card(acme.id, "The Acme review is now on Thursday at 10"),
      await card(acme.id, "Sam moved the Acme check-in to Friday"),
      await card(secret.id, "Buyer Co meeting moved to Monday"),
    ];
    const keep = await card(acme.id, "Acme has 400 staff");
    await api("suggestions/bulk", { method: "POST", body: { action: "reject", ids: rejectIds } });
    await api("suggestions/bulk", { method: "POST", body: { action: "approve", ids: [keep] } });

    answers.card_coach = (c) => ({ lessons: [lesson("Do not propose facts about meetings being moved or rescheduled.", refsIn(c.content, "r"), "You rejected 3 cards about moved meetings")] });
    expect(await coach("gmail_sorter", "knowledge")).toMatchObject({ corrections: 3, proposed: 1 });
    expect(calls[0].content).toContain("You rejected it");
    expect(calls[0].content).toContain("Acme has 400 staff");
    expect(calls[0].content).not.toContain("Buyer Co");
    expect(calls[0].system).toContain("Knowledge Inbox cards");

    const [l] = await db.select().from(readerLessonsTable);
    await setLessonStatus(l.id, "rejected");
    expect((await api("lessons")).body.lessons).toHaveLength(0);
    calls.length = 0;
    expect((await coach("gmail_sorter", "knowledge")).proposed).toBe(0);
    expect(calls[0].content).toContain("Ollie said no to: Do not propose facts about meetings being moved");

    const m = (await scorecards()).find((x) => x.key === "card_lessons")!;
    expect(m).toMatchObject({ kept: 0, undone: 1 });
  });

  it("runs weekly, and the card coach sooner once 50 cards have been decided", async () => {
    reset();
    answers.reader_coach = () => ({ lessons: [] });
    answers.card_coach = () => ({ lessons: [] });
    const now = new Date();
    expect((await learnLessonsIfDue(now)).ran).toEqual(["tasks", "knowledge"]);
    expect((await learnLessonsIfDue(new Date(now.getTime() + 60_000))).ran).toEqual([]);
    const acme = await organisation("Acme");
    for (let i = 0; i < 50; i++) {
      await db.insert(suggestionsTable).values({ kind: "fact", entityType: "organisation", entityId: acme.id, payload: { text: `Fact ${i}` }, normalisedText: `fact ${i}`, proposedBy: "Gmail check", status: "rejected", decidedAt: new Date(now.getTime() + 120_000) });
    }
    expect((await learnLessonsIfDue(new Date(now.getTime() + 180_000))).ran).toEqual(["knowledge"]);
    expect((await learnLessonsIfDue(new Date(now.getTime() + 8 * 86_400_000))).ran).toEqual(["tasks", "knowledge"]);
    // Learn now from the page runs both coaches on every reader.
    const res = await learnLessons();
    expect(res.results).toHaveLength(6);
  });
});
