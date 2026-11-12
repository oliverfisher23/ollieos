/**
 * Section 28: other names on contacts, "Which Paul?", adding a contact from a task, Slack accounts
 * saved on an exact name, due dates the reader guesses, scorecards for the duplicate check and the
 * stuck-task coach, and the numbers for a review.
 */
import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { connectorRunsTable, db, peopleTable, taskDuplicatesTable, tasksTable } from "@workspace/db";
import { addDays, todayLondon } from "@workspace/shared";
import type { SlackRead } from "../src/services/connectors/slack";
import type { SortedUnit } from "../src/services/connectors/sorter";
import type { WorkUnit } from "../src/services/connectors/messages";
import { matchName, nameCandidates } from "../src/services/personNames";
import { linkPeopleToTasks, personSuggestionsFor } from "../src/services/taskPeople";
import { scorecards } from "../src/services/scorecards";
import { taskReview } from "../src/services/taskReview";
import { api, call, connect, mcp, useServer } from "./harness";
import { person } from "./helpers";

let nextSlack: SlackRead = emptySlack();
let answer: (u: WorkUnit, i: number) => Partial<SortedUnit> = () => ({});

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

useServer();

const today = todayLondon();
const DAY = 86_400_000;

async function task(title: string, o: Partial<typeof tasksTable.$inferInsert> = {}) {
  const [t] = await db.insert(tasksTable).values({ title, status: "backlog", createdBy: "test", ...o }).returning();
  return t;
}
const reload = async (id: number) => (await db.select().from(tasksTable).where(eq(tasksTable.id, id)))[0];
const reloadPerson = async (id: number) => (await db.select().from(peopleTable).where(eq(peopleTable.id, id)))[0];

const item = (o: Record<string, unknown>) => ({ ref: "", type: "task", title: "", action: "", priority: "medium", due: "", project: "", person: "", quote: "", confidential: false, same_as: "", quick: false, steps: [], due_guess: "", ...o }) as never;

let n = 0;
function slackFrom(name: string, slackId: string, text: string): WorkUnit {
  const at = new Date(Date.now() - 60_000 + n++ * 1000);
  const ref = `slack:D${slackId}:${(at.getTime() / 1000).toFixed(6)}`;
  return {
    source: "slack",
    key: ref,
    subject: null,
    channel: name,
    people: [{ name, email: null, slackId }],
    messages: [{ ref, at, fromMe: false, fromName: name, fromAddress: null, fromSlackId: slackId, text, url: "https://x.slack.com/archives/D/p1" }],
    conversation: { id: "D" + slackId, kind: "im" },
  };
}

async function slackCheck(units: WorkUnit[]) {
  nextSlack = { ...emptySlack(), units, found: units.length };
  const r = await api("connectors/slack/check", { method: "POST" });
  expect(r.body).toMatchObject({ ok: true });
  return r.body.counts as Record<string, number>;
}

describe("Other names", () => {
  it("matches a nickname, with or without the surname, and lists everyone a name could mean", () => {
    const people = [
      { id: 1, name: "Vova Tatsakovych", otherNames: ["Volodymyr"] },
      { id: 2, name: "Paul Buxton", otherNames: [] },
      { id: 3, name: "Paul Clarke", otherNames: ["PC"] },
    ];
    expect(matchName("Volodymyr", people)?.id).toBe(1);
    expect(matchName("Volodymyr Tatsakovych", people)?.id).toBe(1);
    expect(matchName("Vova", people)?.id).toBe(1);
    expect(matchName("PC", people)?.id).toBe(3);
    expect(nameCandidates("Paul", people).map((p) => p.id)).toEqual([2, 3]);
    expect(nameCandidates("Kevin", people)).toEqual([]);
  });

  it("saves other names on a contact, tidied, and the next pass links by them", async () => {
    const vova = await person("Vova Tatsakovych");
    const t = await task("Volodymyr to set up springpod.io in Route53", { status: "waiting" });
    expect(await linkPeopleToTasks()).toEqual({ checked: 1, linked: 0 });

    const saved = (await api(`people/${vova.slug}`, { method: "PATCH", body: { otherNames: [" Volodymyr ", "volodymyr", "Vova Tatsakovych", "Vlad"] } })).body;
    expect(saved.person?.otherNames ?? saved.otherNames).toEqual(["Volodymyr", "Vlad"]);
    await db.update(tasksTable).set({ personCheckedAt: null }).where(eq(tasksTable.id, t.id));
    expect(await linkPeopleToTasks()).toEqual({ checked: 1, linked: 1 });
    expect((await reload(t.id)).waitingOnPersonId).toBe(vova.id);
  });
});

describe("Person suggestions", () => {
  it("asks which Paul, offers to add Kevin, and offers to remember Volodymyr for Vova", async () => {
    const buxton = await person("Paul Buxton");
    const clarke = await person("Paul Clarke");
    const vova = await person("Vova Tatsakovych");
    const which = await task("Paul (RAF) to reply about the ADS event", { status: "waiting" });
    const add = await task("Kevin to confirm Strada panel participation", { status: "waiting" });
    const remember = await task("Volodymyr to set up springpod.io in Route53", { status: "waiting", waitingOnPersonId: vova.id });
    const sender = await task("Reply about the offsite", { source: "email", fromName: "Mel Okafor", fromAddress: "mel@client.com" });
    const titled = await task("Send Paul the RAF stats", { source: "manual", fromName: "Ollie" });
    const nothing = await task("Check Route53 for Rolls Royce", { source: "manual" });

    expect(await personSuggestionsFor(which.id)).toMatchObject({ slot: "waitingOn", name: "Paul", people: [{ id: buxton.id }, { id: clarke.id }], canAdd: false });
    expect(await personSuggestionsFor(add.id)).toMatchObject({ slot: "waitingOn", name: "Kevin", people: [], canAdd: true });
    const r = (await api(`tasks/${remember.id}/person-suggestions`)).body;
    expect(r).toMatchObject({ slot: null, remember: { person: { id: vova.id }, name: "Volodymyr", otherNames: [] } });
    expect(await personSuggestionsFor(sender.id)).toMatchObject({ slot: "person", name: "Mel Okafor", canAdd: true });
    expect(await personSuggestionsFor(titled.id)).toMatchObject({ slot: "person", name: "Paul", people: [{ id: buxton.id }, { id: clarke.id }] });
    // A capitalised word in a title is never enough to offer a new contact.
    expect(await personSuggestionsFor(nothing.id)).toMatchObject({ slot: null, canAdd: false });

    // Once the name is remembered, there is nothing left to offer.
    await api(`people/${vova.slug}`, { method: "PATCH", body: { otherNames: ["Volodymyr"] } });
    expect((await personSuggestionsFor(remember.id)).remember).toBeNull();
  });
});

describe("Slack accounts", () => {
  it("saves a Slack account on the one contact with exactly that full name, never on a first name", async () => {
    const sam = await person("Sam Hyams");
    const zoe = await person("Zoe Bracegirdle");
    const taken = await person("Kurt Skillen");
    await db.update(peopleTable).set({ slackUserId: "UOLD" }).where(eq(peopleTable.id, taken.id));
    await slackCheck([slackFrom("Sam Hyams", "USAM", "Hello"), slackFrom("Zoe", "UZOE", "Hi"), slackFrom("Kurt Skillen", "UNEW", "Hey")]);
    expect((await reloadPerson(sam.id)).slackUserId).toBe("USAM");
    expect((await reloadPerson(zoe.id)).slackUserId).toBeNull();
    // Someone who already has a Slack account keeps it.
    expect((await reloadPerson(taken.id)).slackUserId).toBe("UOLD");

    // Later messages match by the account, whatever name Slack shows.
    const u = slackFrom("Sammy", "USAM", "Can you send the numbers?");
    answer = () => ({ items: [item({ ref: u.messages[0].ref, title: "Send the numbers" })] });
    await slackCheck([u]);
    const [t] = await db.select().from(tasksTable);
    expect(t.personId).toBe(sam.id);
  });
});

describe("Due dates", () => {
  it("keeps the reader's guess as a suggestion, only while the task has no date", async () => {
    const u = slackFrom("Zoe Bracegirdle", "UZ2", "Could you look at the deck this week, and send the costs by the 20th?");
    const fri = addDays(today, 3);
    answer = () => ({
      items: [
        item({ ref: u.messages[0].ref, title: "Look at the deck", due_guess: fri }),
        item({ ref: u.messages[0].ref, title: "Send the costs", due: addDays(today, 8), due_guess: fri }),
        item({ ref: u.messages[0].ref, title: "Think about the offsite", due_guess: "soon" }),
      ],
    });
    await slackCheck([u]);
    const rows = await db.select().from(tasksTable).orderBy(tasksTable.id);
    expect(rows.map((t) => [t.title, t.dueDate, t.suggestedDue])).toEqual([
      ["Look at the deck", null, fri],
      ["Send the costs", addDays(today, 8), null],
      ["Think about the offsite", null, null],
    ]);
    expect((await api(`tasks/${rows[0].id}`)).body.task.suggestedDue).toBe(fri);
    const dated = (await api(`tasks/${rows[0].id}`, { method: "PATCH", body: { dueDate: fri } })).body;
    expect(dated).toMatchObject({ dueDate: fri, suggestedDue: null });
  });
});

describe("Scorecards and the review", () => {
  it("scores the duplicate check and the stuck-task coach from what Ollie did", async () => {
    const hint = { why: "Due date moved 2 times", kind: "first_step", suggestion: "Start small", step: "List the items" };
    const used = await task("Stuck one", { stuckHint: hint, stuckCheckedAt: new Date() });
    const not = await task("Stuck two", { stuckHint: hint, stuckCheckedAt: new Date() });
    await task("Stuck three", { stuckHint: hint, stuckCheckedAt: new Date() });
    expect((await api(`tasks/${used.id}/stuck/dismiss`, { body: { used: true } })).body.stuckHint).toBeNull();
    await api(`tasks/${not.id}/stuck/dismiss`, { method: "POST" });
    expect((await reload(used.id)).stuckHint).toMatchObject({ outcome: "used", step: "List the items" });
    expect((await reload(not.id)).stuckHint).toMatchObject({ outcome: "not_stuck" });

    const [a, b, c, d] = [await task("A"), await task("B"), await task("C"), await task("D")];
    await db.insert(taskDuplicatesTable).values([
      { taskA: a.id, taskB: b.id, state: "merged" },
      { taskA: a.id, taskB: c.id, state: "dismissed" },
      { taskA: a.id, taskB: d.id, state: "suggested" },
      { taskA: b.id, taskB: c.id, state: "not_same" },
    ]);
    const cards = await scorecards();
    expect(cards.find((m) => m.key === "stuck_suggestions")).toMatchObject({ agent: "stuck_coach", kept: 1, undone: 1, waiting: 1, rate: 50 });
    expect(cards.find((m) => m.key === "duplicate_pairs")).toMatchObject({ agent: "duplicate_judge", kept: 1, undone: 1, waiting: 1, rate: 50 });
  });

  it("counts what a review needs, and Claude can read it and each task's reason", async () => {
    const sam = await person("Sam Hyams");
    await task("Done fast", { source: "slack", status: "done", completedAt: new Date() });
    await task("Has it all", { source: "email", status: "now", personId: sam.id, dueDate: addDays(today, 2), steps: [{ id: "s1", title: "One", done: false }] });
    await task("Waiting, nobody", { source: "slack", status: "waiting", waitingSince: new Date(Date.now() - 5 * DAY) });
    await task("Guessed", { source: "meeting", status: "inbox", suggestedDue: addDays(today, 1) });
    const dropped = await task("Not for me", { source: "meeting", status: "inbox" });
    await api(`tasks/${dropped.id}`, { method: "PATCH", body: { status: "dropped", dropReason: "not_mine" } });
    await db.insert(connectorRunsTable).values({ connector: "slack", trigger: "test", startedAt: new Date(), ok: true, counts: { quick_replies: 3, linked: 2, inbox: 1 } });

    const r = await taskReview(7);
    expect(r.made).toMatchObject({ total: 5, done: 1, dropped: 1, open: 3, doneWithin30Min: 1, withChecklist: 1 });
    expect(r.made.bySource.slack).toMatchObject({ total: 2, done: 1 });
    expect(r.dropReasons).toMatchObject({ not_mine: 1, none_given: 0 });
    expect(r.readers).toEqual({ quickRepliesLeftOnMessages: 3, addedToExistingTasks: 2 });
    expect(r.openNow).toMatchObject({ total: 3, withPerson: 1, withDueDate: 1, dueDateSuggested: 1, waiting: 1, waitingWithPerson: 0, toChase: 1 });
    expect((await api("tasks/review?days=7")).body.made.total).toBe(5);

    const { access_token } = await connect("Claude");
    const c = await mcp(access_token);
    expect((await call(c, "get_task_review", {})).json).toMatchObject({ days: 7, dropReasons: { not_mine: 1 } });
    const listed = (await call(c, "list_tasks", { status: ["dropped"] })).json.tasks as { title: string; drop_reason: string | null }[];
    expect(listed).toEqual([expect.objectContaining({ title: "Not for me", drop_reason: "not_mine" })]);
  });
});
