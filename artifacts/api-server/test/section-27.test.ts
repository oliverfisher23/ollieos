/**
 * Section 27: people linked to tasks, quick Slack replies left on Messages, one message as one task
 * with a checklist, Cowork open questions, project suggestions, the overloaded-day warning, bulk
 * changes, drop reasons, chase nudges and the stuck-task coach.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { auditEventsTable, coworkSessionsTable, db, peopleTable, tasksTable } from "@workspace/db";
import { addDays, todayLondon } from "@workspace/shared";
import type { SlackRead } from "../src/services/connectors/slack";
import type { SortedUnit } from "../src/services/connectors/sorter";
import type { WorkUnit } from "../src/services/connectors/messages";
import { matchName, namesInTitle, waitingOnInTitle } from "../src/services/personNames";
import { linkPeopleToTasks } from "../src/services/taskPeople";
import { projectSuggestionsFor } from "../src/services/projectSuggest";
import { isOpenQuestion } from "../src/services/sessions";
import { coachStuckTasks } from "../src/services/stuckCoach";
import type { StuckCandidate } from "../src/services/stuckJudge";
import { api, call, connect, mcp, useServer } from "./harness";
import { person, project } from "./helpers";

let nextSlack: SlackRead = emptySlack();
let answer: (u: WorkUnit, i: number) => Partial<SortedUnit> = () => ({});
let advised: StuckCandidate[] = [];

function emptySlack(): SlackRead {
  return { account: "ollie at Example", me: "UME", opened: [], units: [], found: 0, leftOut: 0, checked: 0, state: { since: new Date().toISOString(), convs: {} } };
}

vi.mock("../src/services/connectors/slack", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/slack")>()),
  readSlack: async () => nextSlack,
  repliedInThread: async () => false,
}));
vi.mock("../src/services/connectors/sorter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/connectors/sorter")>()),
  sortUnits: async (units: WorkUnit[]) => units.map((u, i) => ({ summary: "", project: "", items: [], ...answer(u, i) })),
}));
vi.mock("../src/services/stuckJudge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/stuckJudge")>()),
  adviseStuck: async (tasks: StuckCandidate[]) => {
    advised = tasks;
    return tasks.map((t) => ({ n: t.n, kind: t.title.includes("offsite") ? ("delegate" as const) : ("first_step" as const), suggestion: "Start by listing what is missing", step: "List the open items" }));
  },
}));

useServer();

const today = todayLondon();
const DAY = 86_400_000;

async function task(title: string, o: Partial<typeof tasksTable.$inferInsert> = {}) {
  const [t] = await db.insert(tasksTable).values({ title, status: "backlog", createdBy: "test", ...o }).returning();
  return t;
}
const reload = async (id: number) => (await db.select().from(tasksTable).where(eq(tasksTable.id, id)))[0];

const item = (o: Record<string, unknown>) => ({ ref: "", type: "task", title: "", action: "", priority: "medium", due: "", project: "", person: "", quote: "", confidential: false, same_as: "", quick: false, steps: [], ...o }) as never;

function slackFrom(name: string, text: string): WorkUnit {
  const at = new Date(Date.now() - 60_000);
  const ref = `slack:D7:${(at.getTime() / 1000).toFixed(6)}`;
  return {
    source: "slack",
    key: ref,
    subject: null,
    channel: name,
    // Slack gave no email, and nobody has a Slack id saved: the usual case.
    people: [{ name, email: null, slackId: "UNKNOWN" }],
    messages: [{ ref, at, fromMe: false, fromName: name, fromAddress: null, fromSlackId: "UNKNOWN", text, url: "https://x.slack.com/archives/D7/p1" }],
    conversation: { id: "D7", kind: "im" },
  };
}

async function slackCheck(units: WorkUnit[]) {
  nextSlack = { ...emptySlack(), units, found: units.length };
  const r = await api("connectors/slack/check", { method: "POST" });
  expect(r.body).toMatchObject({ ok: true });
  return r.body.counts as Record<string, number>;
}

describe("Names", () => {
  it("matches first names, initials and Slack-style names, but never guesses between two people", () => {
    const people = [
      { id: 1, name: "Sam Hyams" },
      { id: 2, name: "Zoe Bracegirdle" },
      { id: 3, name: "Paul Buxton" },
      { id: 4, name: "Paul Clarke" },
      { id: 5, name: "Ollie Fisher", isSelf: true },
    ];
    expect(matchName("Sam", people)?.id).toBe(1);
    expect(matchName("sam.hyams", people)?.id).toBe(1);
    expect(matchName("Sam Hyams (he/him)", people)?.id).toBe(1);
    expect(matchName("Sam H", people)?.id).toBe(1);
    expect(matchName("Paul", people)).toBeNull();
    expect(matchName("Paul", people, { prefer: new Set([4]) })?.id).toBe(4);
    expect(matchName("Paul B", people)?.id).toBe(3);
    expect(matchName("Ollie", people)).toBeNull();
    expect(matchName("Sam", people, { fullOnly: true })).toBeNull();
    expect(namesInTitle("Give Zoe a rough figure for time per work activity")).toContain("Zoe");
    expect(namesInTitle("Send Sam Hyams the Q3 numbers")[0]).toBe("Sam Hyams");
    expect(namesInTitle("Mark the report as final")).not.toContain("Mark");
    expect(waitingOnInTitle("Volodymyr to set up springpod.io in Route53")).toBe("Volodymyr");
    expect(waitingOnInTitle("Paul (RAF) to reply about ADS event")).toBe("Paul");
    expect(waitingOnInTitle("Send the deck to Sam")).toBeNull();
  });
});

describe("People on tasks", () => {
  it("links existing tasks once: by sender, by who a waiting title names, and by a name in the title", async () => {
    const sam = await person("Sam Hyams");
    await db.update(peopleTable).set({ email: "sam.hyams@springpod.com" }).where(eq(peopleTable.id, sam.id));
    const zoe = await person("Zoe Bracegirdle");
    const vova = await person("Volodymyr Tatsakovych");
    await person("Paul Buxton");
    await person("Paul Clarke");
    const old = new Date(Date.now() - 40 * DAY);
    const byName = await task("Give feedback on the recruitment idea", { source: "slack", fromName: "Sam Hyams", updatedAt: old });
    const byEmail = await task("Reply about the board pack", { source: "email", fromName: "S Hyams", fromAddress: "Sam.Hyams@springpod.com" });
    const inTitle = await task("Give Zoe a rough figure for time per work activity", { source: "manual", fromName: "Ollie" });
    const waiting = await task("Volodymyr to set up springpod.io in Route53", { status: "waiting", source: "slack", fromName: "You" });
    const unclear = await task("Paul to reply about the ADS event", { status: "waiting", source: "slack", fromName: "You" });

    expect(await linkPeopleToTasks()).toEqual({ checked: 5, linked: 4 });
    expect((await reload(byName.id)).personId).toBe(sam.id);
    // Not a change Ollie made: the stale clock is left alone.
    expect((await reload(byName.id)).updatedAt.getTime()).toBe(old.getTime());
    expect((await reload(byEmail.id)).personId).toBe(sam.id);
    expect((await reload(inTitle.id)).personId).toBe(zoe.id);
    expect(await reload(waiting.id)).toMatchObject({ waitingOnPersonId: vova.id, personId: null });
    // Two Pauls: nobody is guessed.
    expect(await reload(unclear.id)).toMatchObject({ waitingOnPersonId: null, personId: null });

    // Looked at once: a link Ollie removes stays removed.
    await db.update(tasksTable).set({ personId: null }).where(eq(tasksTable.id, inTitle.id));
    expect(await linkPeopleToTasks()).toEqual({ checked: 0, linked: 0 });
    expect((await reload(inTitle.id)).personId).toBeNull();
  });

  it("links a new Slack task to its sender by name, and a first-name hint to the right person", async () => {
    const sam = await person("Sam Hyams");
    const jenni = await person("Jenni Smith");
    const u = slackFrom("Sam Hyams", "Can you send me the Q3 numbers, and ask Jenni to check the Rolls-Royce page?");
    answer = () => ({
      items: [
        item({ ref: u.messages[0].ref, title: "Send Sam the Q3 numbers" }),
        item({ ref: u.messages[0].ref, type: "waiting", title: "Jenni to check the Rolls-Royce page", person: "Jenni" }),
      ],
    });
    await slackCheck([u]);
    const rows = await db.select().from(tasksTable).orderBy(tasksTable.id);
    expect(rows.map((t) => [t.title, t.personId, t.waitingOnPersonId])).toEqual([
      ["Send Sam the Q3 numbers", sam.id, null],
      ["Jenni to check the Rolls-Royce page", null, jenni.id],
    ]);
  });
});

describe("Readers", () => {
  it("leaves a quick Slack reply on Messages instead of making a task, but keeps real work", async () => {
    const u = slackFrom("Zoe Bracegirdle", "Are you around at 3? Also can you fix the SCORM publish error?");
    answer = () => ({
      reply: { needs: "reply", ask: "Wants to know if you are free at 3" },
      items: [item({ ref: u.messages[0].ref, title: "Tell Zoe if you are free at 3", quick: true }), item({ ref: u.messages[0].ref, title: "Fix the SCORM publish error" })],
    });
    const counts = await slackCheck([u]);
    expect(counts).toMatchObject({ quick_replies: 1, inbox: 1 });
    expect((await db.select().from(tasksTable)).map((t) => t.title)).toEqual(["Fix the SCORM publish error"]);
  });

  it("keeps a quick item as a task when the conversation is not waiting on Ollie's reply", async () => {
    const u = slackFrom("Zoe Bracegirdle", "Can you confirm the date?");
    answer = () => ({ reply: { needs: "none", ask: "" }, items: [item({ ref: u.messages[0].ref, title: "Confirm the date with Zoe", quick: true })] });
    expect((await slackCheck([u])).inbox).toBe(1);
  });

  it("makes one task with a checklist from one message that asks for several things", async () => {
    const u = slackFrom("Lisa Jiang", "Could you issue a partner API key, answer our questions and pick a time for a call?");
    answer = () => ({ items: [item({ ref: u.messages[0].ref, title: "Get ETS what they need to start the build", steps: ["Issue a partner API key with test data", "Answer the Partner API questions", " Pick a time for the follow-up call "] })] });
    await slackCheck([u]);
    const [t] = await db.select().from(tasksTable);
    expect(t.steps.map((s) => [s.title, s.done])).toEqual([
      ["Issue a partner API key with test data", false],
      ["Answer the Partner API questions", false],
      ["Pick a time for the follow-up call", false],
    ]);
  });
});

describe("Cowork open questions", () => {
  it("tells questions from actions", () => {
    for (const q of ["Decide whether the Employability suite continues or is retired", "Confirm whether group briefs are on the roadmap", "Check if the deck matches the live site", "Is the cohort date fixed?"]) expect(isOpenQuestion(q)).toBe(true);
    for (const a of ["Send the Army information pack to Paul Buxton", "Confirm the demo date with Mel", "Check the university section of the partner deck"]) expect(isOpenQuestion(a)).toBe(false);
  });

  it("keeps questions on the session, sends real actions to the Inbox, and lets Ollie add or dismiss one", async () => {
    const { access_token } = await connect("Claude");
    const c = await mcp(access_token);
    const out = await call(c, "save_session", {
      session_id: "q-1",
      title: "Messaging review",
      summary: "Went through the messaging house.",
      actions: [{ title: "Send the Army information pack to Paul Buxton" }, { title: "Decide whether the Employability suite continues or is retired" }],
      open_questions: ["Whether micro-internships have fixed cohort dates"],
    });
    expect(out.json).toMatchObject({ open_questions_kept: 2 });
    expect((out.json.tasks as unknown[]).length).toBe(1);
    expect((await db.select().from(tasksTable)).map((t) => t.title)).toEqual(["Send the Army information pack to Paul Buxton"]);

    const [s] = await db.select().from(coworkSessionsTable);
    const detail = (await api(`sessions/${s.id}`)).body;
    expect(detail.openQuestions).toEqual(["Whether micro-internships have fixed cohort dates", "Decide whether the Employability suite continues or is retired"]);

    const added = (await api(`sessions/${s.id}/questions`, { body: { question: detail.openQuestions[1], action: "task" } })).body;
    expect(added.openQuestions).toEqual(["Whether micro-internships have fixed cohort dates"]);
    expect(added.tasks.map((t: { title: string }) => t.title)).toContain("Decide whether the Employability suite continues or is retired");
    const gone = (await api(`sessions/${s.id}/questions`, { body: { question: "Whether micro-internships have fixed cohort dates", action: "dismiss" } })).body;
    expect(gone.openQuestions).toEqual([]);
    expect((await api(`sessions/${s.id}/questions`, { body: { question: "Not there", action: "dismiss" } })).status).toBe(404);
  });
});

describe("Project suggestions", () => {
  it("suggests from the same meeting, the person's other tasks, and a project named in the title", async () => {
    const delivery = await project("Delivery");
    const ets = await project("ETS Partnership");
    const website = await project("Website rebuild");
    const lisa = await person("Lisa Jiang");
    const url = "https://notes.granola.ai/d/abc";
    await task("Tidy up the data mapping diagram", { source: "meeting", sourceUrl: url, projectId: delivery.id });
    const sameMeeting = await task("Add screen views to Studio", { source: "meeting", sourceUrl: url });
    await task("Answer ETS questions", { personId: lisa.id, projectId: ets.id });
    const samePerson = await task("Pick a time for the call", { personId: lisa.id });
    const named = await task("Approve the two new pages for the website rebuild");
    const none = await task("Buy milk");

    expect((await projectSuggestionsFor(sameMeeting.id)).map((p) => p.name)).toEqual(["Delivery"]);
    expect((await projectSuggestionsFor(samePerson.id)).map((p) => p.name)).toEqual(["ETS Partnership"]);
    expect((await api(`tasks/${named.id}/project-suggestions`)).body.projects.map((p: { name: string }) => p.name)).toEqual(["Website rebuild"]);
    expect(await projectSuggestionsFor(none.id)).toEqual([]);
    await db.update(tasksTable).set({ projectId: website.id }).where(eq(tasksTable.id, named.id));
    expect(await projectSuggestionsFor(named.id)).toEqual([]);
  });
});

describe("Load, bulk changes and reasons", () => {
  it("flags the overloaded day and overdue tasks, lists them, and changes several at once", async () => {
    const fri = addDays(today, 1);
    const ids: number[] = [];
    for (const n of [1, 2, 3, 4]) ids.push((await task(`Due Friday ${n}`, { dueDate: fri })).id);
    await task("In Now already", { dueDate: fri, status: "now" });
    await task("Late one", { dueDate: addDays(today, -1) });
    await task("Quiet day", { dueDate: addDays(today, 3) });

    const load = (await api("tasks/summary")).body.load;
    expect(load).toMatchObject({ overdue: 1, busiest: { date: fri, due: 5, inNow: 1 } });
    expect(((await api(`tasks?tab=open&due=${fri}`)).body as unknown as unknown[]).length).toBe(5);
    expect(((await api("tasks?tab=open&due=overdue")).body as unknown as { title: string }[]).map((t) => t.title)).toEqual(["Late one"]);
    expect((await api("tasks?tab=open&due=tomorrow")).status).toBe(400);

    const r = (await api("tasks/bulk", { body: { ids: [...ids, 999999], status: "now", priority: "high" } })).body;
    expect(r).toEqual({ updated: 4, failed: 1 });
    expect((await reload(ids[0])).status).toBe("now");
    expect((await reload(ids[3])).priority).toBe("high");
    // Now most of Friday is in Now, the warning goes.
    expect((await api("tasks/summary")).body.load.busiest).toBeNull();
  });

  it("keeps why an item was dropped, and forgets it when the item comes back", async () => {
    const t = await task("Konrad to map survey codes", { source: "meeting", status: "inbox" });
    await api(`tasks/${t.id}`, { method: "PATCH", body: { status: "dropped" } });
    const dropped = (await api(`tasks/${t.id}`, { method: "PATCH", body: { dropReason: "not_mine" } })).body;
    expect(dropped).toMatchObject({ status: "dropped", dropReason: "not_mine" });
    const history = (await api(`tasks/${t.id}`)).body.history as { changes?: { field: string; to: string | null }[] }[];
    expect(JSON.stringify(history)).toContain("Not mine");
    expect((await api(`tasks/${t.id}`, { method: "PATCH", body: { dropReason: "bored" } })).status).toBe(400);
    expect((await api(`tasks/${t.id}`, { method: "PATCH", body: { status: "backlog" } })).body.dropReason).toBeNull();
  });
});

describe("Chase nudges", () => {
  it("flags a Waiting on task after three days, and Not yet gives it three more", async () => {
    const old = await task("Kevin to confirm the panel", { status: "waiting", waitingSince: new Date(Date.now() - 4 * DAY) });
    const fresh = await task("Jenni to ask Rolls-Royce", { status: "waiting", waitingSince: new Date(Date.now() - DAY) });
    expect((await api(`tasks/${old.id}`)).body.task.chaseDue).toBe(true);
    expect((await api(`tasks/${fresh.id}`)).body.task.chaseDue).toBe(false);
    expect((await api("tasks/summary")).body.load.toChase).toBe(1);

    expect((await api(`tasks/${old.id}/chase-later`, { method: "POST" })).body.chaseDue).toBe(false);
    expect((await api("tasks/summary")).body.load.toChase).toBe(0);
    // Moving it out of Waiting and back starts the usual wait again.
    await api(`tasks/${old.id}`, { method: "PATCH", body: { status: "now" } });
    await api(`tasks/${old.id}`, { method: "PATCH", body: { status: "waiting" } });
    expect((await reload(old.id)).chaseAfter).toBeNull();
  });
});

describe("Stuck-task coach", () => {
  it("finds tasks that keep slipping without AI, asks for one thing to try, and Not stuck ends it", async () => {
    const moved = await task("Update the due diligence register", { dueDate: addDays(today, 2) });
    for (const d of [3, 4]) await api(`tasks/${moved.id}`, { method: "PATCH", body: { dueDate: addDays(today, d) } });
    const overdue = await task("Book the offsite venue", { dueDate: addDays(today, -6) });
    const idle = await task("Build the ADS demo", { status: "now", updatedAt: new Date(Date.now() - 9 * DAY) });
    const fine = await task("Send the deck", { dueDate: addDays(today, 1) });
    const hidden = await task("Sort the bonus letters", { dueDate: addDays(today, -9), confidential: true });
    expect((await db.select().from(auditEventsTable).where(eq(auditEventsTable.entityId, moved.id))).length).toBe(2);

    const r = await coachStuckTasks();
    expect(r).toMatchObject({ stuck: 3, failed: false });
    expect(advised.map((a) => a.why).sort()).toEqual(["6 days overdue", "Due date moved 2 times", "In Now for 9 days without a change"]);
    expect(advised.some((a) => a.title.includes("bonus"))).toBe(false);

    const t = (await api(`tasks/${moved.id}`)).body.task;
    expect(t.stuckHint).toEqual({ why: "Due date moved 2 times", kind: "first_step", suggestion: "Start by listing what is missing", step: "List the open items" });
    // "Delegate" needs a colleague the delegation suggester named; without one it falls back to a first step.
    expect((await api(`tasks/${overdue.id}`)).body.task.stuckHint.kind).toBe("first_step");
    expect((await api(`tasks/${fine.id}`)).body.task.stuckHint).toBeNull();
    expect((await reload(hidden.id)).stuckCheckedAt).toBeNull();
    // Looking at a task does not reset "In Now for 9 days".
    expect(Date.now() - (await reload(idle.id)).updatedAt.getTime()).toBeGreaterThan(8 * DAY);

    expect((await api(`tasks/${moved.id}/stuck/dismiss`, { method: "POST" })).body.stuckHint).toBeNull();
    expect(await coachStuckTasks()).toMatchObject({ stuck: 0 });
  });
});
