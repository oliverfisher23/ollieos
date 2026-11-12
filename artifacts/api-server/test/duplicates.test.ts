/** Section 26: one task across channels. */
import { describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { captureLogTable, db, taskDuplicatesTable, taskEvidenceTable, tasksTable } from "@workspace/db";
import { addDays, todayLondon } from "@workspace/shared";
import { captureMeetings } from "../src/services/connectors/meetingCapture";
import type { MeetingNote } from "../src/services/connectors/granola";
import { closeOpenTasks, findDuplicates, isCandidateMatch, isStrongMatch, lexemesOf, similarOpenTasks, titleMatch } from "../src/services/duplicates";
import type { DuplicateCandidate } from "../src/services/duplicateJudge";
import { OLLIE, api, call, connect, mcp, useServer } from "./harness";

let meetingContent = "";
/** What the fake meeting reader returns, given the content it was sent */
let answer: (content: string) => unknown[] = () => [];
let judged: DuplicateCandidate[] = [];
let same: (c: DuplicateCandidate) => boolean = () => true;

vi.mock("../src/services/connectors/sorter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/sorter")>()),
  haikuJson: async (_system: string, content: string) => {
    meetingContent = content;
    return { summary: "", project: "", items: answer(content), decisions: [], progress: [], covered: [], tone: "neutral", tone_reason: "" };
  },
}));
vi.mock("../src/services/duplicateJudge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/duplicateJudge")>()),
  judgeDuplicates: async (pairs: DuplicateCandidate[]) => {
    judged = pairs;
    return pairs.map((p) => ({ pair: p.pair, same: same(p), reason: same(p) ? "Both are the Q3 numbers for Sam" : "" }));
  },
}));

useServer();

async function task(title: string, o: Partial<typeof tasksTable.$inferInsert> = {}) {
  const [t] = await db.insert(tasksTable).values({ title, status: "now", createdBy: "test", ...o }).returning();
  return t;
}

const item = (title: string, same_as = "") => ({ ref: "granola:d1", type: "task", title, action: "", priority: "medium", due: "", project: "", person: "", quote: "Ollie to get Sam the Q3 numbers", confidential: false, owner: "Oliver", same_as });

const note = (): MeetingNote => ({
  noteId: "d1",
  title: "Pipeline review",
  url: "https://notes.granola.ai/d/d1",
  at: new Date(),
  calendarEventId: null,
  ownedByMe: true,
  people: [],
  notes: "Next steps\n- Get Sam the Q3 revenue numbers by Friday (Oliver)\n- Book the offsite venue (Oliver)",
});

describe("Matching words", () => {
  it("stems titles, ignores words most tasks share, and scores the overlap", async () => {
    const [a, b, c] = await lexemesOf(["Send Sam the Q3 revenue numbers", "Q3 revenue numbers to Sam", "Send the board pack"]);
    expect(a).toEqual(expect.arrayContaining(["sam", "q3", "revenu", "number"]));
    expect(a).not.toContain("send");
    expect(isStrongMatch(titleMatch(a, b))).toBe(true);
    expect(isCandidateMatch(titleMatch(a, c))).toBe(false);
  });

  it("finds open tasks whose words appear in an exchange, but not closed ones", async () => {
    const open = await task("Send Sam the Q3 revenue numbers");
    await task("Q3 revenue numbers for Amy", { status: "done" });
    await task("Book the offsite venue");
    expect(await similarOpenTasks("Sam asked again for the Q3 revenue numbers before the board", { limit: 5 })).toEqual([open.id]);
    expect((await closeOpenTasks("Q3 revenue numbers to Sam")).map((t) => t.id)).toEqual([open.id]);
    expect(await closeOpenTasks("Revenue plan for next year")).toEqual([]);
  });
});

describe("Readers add to a task Ollie already has", () => {
  it("offers a similar task from another channel, and adds the item to it instead of making a new one", async () => {
    const existing = await task("Send Sam the Q3 revenue numbers", { source: "slack", sourceRef: "slack:C1:1" });
    answer = (content) => {
      const ref = /\[(task:\d+)\] from elsewhere, task: Send Sam the Q3 revenue numbers/.exec(content)?.[1] ?? "";
      return [item("Get Sam the Q3 revenue numbers", ref), item("Book the offsite venue")];
    };
    const counts = await captureMeetings([note()], { me: "His email address is " + OLLIE, now: new Date(), myEmails: new Set([OLLIE]) });
    expect(meetingContent).toContain(`[task:${existing.id}] from elsewhere, task: Send Sam the Q3 revenue numbers`);
    expect(counts).toMatchObject({ linked: 1, inbox: 1 });

    const titles = (await db.select().from(tasksTable).where(eq(tasksTable.source, "meeting"))).map((t) => t.title);
    expect(titles).toEqual(["Book the offsite venue"]);
    const [e] = await db.select().from(taskEvidenceTable).where(eq(taskEvidenceTable.taskId, existing.id));
    expect(e).toMatchObject({ source: "meeting", shows: "same", place: "Meeting: Pipeline review", quote: "Ollie to get Sam the Q3 numbers" });
    const [log] = await db.select().from(captureLogTable).where(and(eq(captureLogTable.source, "meeting"), eq(captureLogTable.sourceRef, "granola:d1")));
    expect(log).toMatchObject({ outcome: "duplicate", taskId: existing.id });

    // The task now says where else it came up, and "What OllieOS has seen" lists it.
    const t = (await api(`tasks/${existing.id}`)).body.task;
    expect(t.alsoFrom).toEqual(["meeting"]);
    expect((await api(`tasks/${existing.id}/evidence`)).body[0]).toMatchObject({ shows: "same", source: "meeting" });
    expect(t.looksDone).toBeNull();
  });

  it("ignores a same_as for a task it was not offered", async () => {
    const other = await task("Something unrelated entirely");
    answer = () => [item("Get Sam the Q3 revenue numbers", `task:${other.id}`)];
    const counts = await captureMeetings([note()], { me: "", now: new Date(), myEmails: new Set([OLLIE]) });
    expect(counts.linked ?? 0).toBe(0);
    expect((await db.select().from(tasksTable).where(eq(tasksTable.source, "meeting"))).map((t) => t.title)).toEqual(["Get Sam the Q3 revenue numbers"]);
  });
});

describe("Claude and Cowork check first", () => {
  it("create_task returns a close match instead of making it, and can add to it or make it anyway", async () => {
    const existing = await task("Send Sam the Q3 revenue numbers");
    const { access_token } = await connect("Claude");
    const c = await mcp(access_token);

    const held = await call(c, "create_task", { title: "Q3 revenue numbers to Sam" });
    expect(held.json).toMatchObject({ created: false, possible_duplicates: [expect.objectContaining({ ref: `task:${existing.id}` })] });

    const linked = await call(c, "create_task", { title: "Q3 revenue numbers to Sam", same_as: `task:${existing.id}`, source_quote: "Sam needs these for the board" });
    expect(linked.json).toMatchObject({ linked: true, duplicate: false });
    const [e] = await db.select().from(taskEvidenceTable).where(eq(taskEvidenceTable.taskId, existing.id));
    expect(e).toMatchObject({ shows: "same", saidBy: "Claude", quote: "Sam needs these for the board" });

    const made = await call(c, "create_task", { title: "Q3 revenue numbers to Sam", not_duplicate: true });
    expect(made.json).toMatchObject({ duplicate: false, task: expect.objectContaining({ title: "Q3 revenue numbers to Sam" }) });
    expect((await call(c, "create_task", { title: "Book the offsite venue" })).json).toMatchObject({ duplicate: false });
  });

  it("save_session adds an action to an open task with nearly the same title", async () => {
    const existing = await task("Send Sam the Q3 revenue numbers");
    const { access_token } = await connect("Claude");
    const c = await mcp(access_token);
    const out = await call(c, "save_session", {
      session_id: "cowork-1",
      title: "Board prep",
      summary: "Prepared the board pack.",
      actions: [{ title: "Q3 revenue numbers to Sam" }, { title: "Book the offsite venue" }],
    });
    expect((out.json.tasks as { outcome: string }[]).map((t) => t.outcome)).toEqual(["linked", "created"]);
    const [e] = await db.select().from(taskEvidenceTable).where(eq(taskEvidenceTable.taskId, existing.id));
    expect(e).toMatchObject({ source: "session", shows: "same", place: "Cowork session: Board prep" });
    // Saving the same session again changes nothing.
    const again = await call(c, "save_session", { session_id: "cowork-1", title: "Board prep", summary: "Prepared the board pack.", actions: [{ title: "Q3 revenue numbers to Sam" }, { title: "Book the offsite venue" }] });
    expect((again.json.tasks as { outcome: string }[]).map((t) => t.outcome)).toEqual(["duplicate", "duplicate"]);
    // A different session about the same work is added to the same tasks.
    const other = await call(c, "save_session", { session_id: "cowork-2", title: "Board follow-up", summary: "Followed up.", actions: [{ title: "Book the offsite venue" }] });
    expect((other.json.tasks as { outcome: string }[]).map((t) => t.outcome)).toEqual(["linked"]);
  });
});

describe("Duplicates page", () => {
  it("finds similar pairs, asks the judge once, and merges into the task Ollie keeps", async () => {
    const today = todayLondon();
    const a = await task("Send Sam the Q3 revenue numbers", { source: "slack", sourceRef: "slack:C9:1", dueDate: addDays(today, 5), priority: "medium", notes: "From the pipeline channel" });
    const b = await task("Q3 revenue numbers for Sam", { source: "email", sourceRef: "gmail:abc", dueDate: addDays(today, 2), priority: "high", sourceQuote: "Can you get me the Q3 numbers?", fromName: "Sam Lee" });
    await task("Book the offsite venue");
    same = () => true;
    expect(await findDuplicates()).toEqual({ checked: 1, found: 1 });
    expect(judged.map((p) => [p.a.title, p.b.title])).toEqual([["Send Sam the Q3 revenue numbers", "Q3 revenue numbers for Sam"]]);
    // Each pair is judged once.
    expect(await findDuplicates()).toEqual({ checked: 0, found: 0 });

    const list = (await api("tasks/duplicates")).body.pairs as { id: number; reason: string; a: { id: number }; b: { id: number } }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ reason: "Both are the Q3 numbers for Sam", a: { id: a.id }, b: { id: b.id } });

    expect((await api(`tasks/duplicates/${list[0].id}/merge`, { body: { keep: 999 } })).status).toBe(400);
    const kept = (await api(`tasks/duplicates/${list[0].id}/merge`, { body: { keep: a.id } })).body;
    expect(kept).toMatchObject({ id: a.id, dueDate: addDays(today, 2), priority: "high", alsoFrom: ["email"] });
    const [dropped] = await db.select().from(tasksTable).where(eq(tasksTable.id, b.id));
    expect(dropped.status).toBe("dropped");
    expect(dropped.notes).toContain('Merged into "Send Sam the Q3 revenue numbers".');
    const [e] = await db.select().from(taskEvidenceTable).where(eq(taskEvidenceTable.taskId, a.id));
    expect(e).toMatchObject({ source: "email", sourceRef: "gmail:abc", saidBy: "Sam Lee", quote: "Can you get me the Q3 numbers?", shows: "same" });
    expect((await api("tasks/duplicates")).body.pairs).toEqual([]);
    expect((await api(`tasks/duplicates/${list[0].id}/merge`, { body: { keep: a.id } })).status).toBe(400);
  });

  it("keeps pairs the judge or Ollie says are not the same off the page for good", async () => {
    await task("Send Sam the Q3 revenue numbers");
    await task("Q3 revenue numbers for Sam");
    await task("Draft the Q3 revenue numbers for Amy");
    same = (p) => p.a.title.includes("Sam") && p.b.title.includes("Sam");
    const r = await findDuplicates();
    expect(r.found).toBe(1);
    expect((await db.select().from(taskDuplicatesTable).where(eq(taskDuplicatesTable.state, "not_same"))).length).toBe(r.checked - 1);

    const [pair] = (await api("tasks/duplicates")).body.pairs as { id: number }[];
    expect((await api(`tasks/duplicates/${pair.id}/dismiss`, { method: "POST" })).status).toBe(204);
    expect((await api("tasks/duplicates")).body.pairs).toEqual([]);
    expect(await findDuplicates()).toEqual({ checked: 0, found: 0 });
  });

  it("never compares tasks hidden from AI", async () => {
    await task("Send Sam the Q3 revenue numbers", { confidential: true });
    await task("Q3 revenue numbers for Sam");
    expect(await findDuplicates()).toEqual({ checked: 0, found: 0 });
  });
});
