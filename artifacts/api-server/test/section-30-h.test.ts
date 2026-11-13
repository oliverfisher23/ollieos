/**
 * Section 30, Part H: a project and due date filled in where there is one clear answer, people links
 * marked as OllieOS's, Undo that is never undone again, and the guess at why an item was dropped.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, taskEvidenceTable, tasksTable } from "@workspace/db";
import { addDays, todayLondon } from "@workspace/shared";
import { fillTasks, guessDropReason } from "../src/services/autoFill";
import { linkPeopleToTasks } from "../src/services/taskPeople";
import { taskReview } from "../src/services/taskReview";
import { api, useServer } from "./harness";
import { person, project } from "./helpers";

useServer();

const today = todayLondon();

async function task(title: string, values: Partial<typeof tasksTable.$inferInsert> = {}) {
  const [row] = await db.insert(tasksTable).values({ title, status: "backlog", createdBy: "ollieos", ...values }).returning();
  return row;
}
const fresh = async (id: number) => (await db.select().from(tasksTable).where(eq(tasksTable.id, id)))[0];
const view = async (id: number) => (await api(`tasks/${id}`)).body.task;

describe("Filled in for you", () => {
  it("sets the one clear project, leaves two close candidates as chips, and does not count as touching the task", async () => {
    const delivery = await project("Delivery");
    const ets = await project("ETS Partnership");
    const lisa = await person("Lisa Jiang");
    const url = "https://notes.granola.ai/d/abc";
    await task("Tidy up the data mapping diagram", { source: "meeting", sourceUrl: url, projectId: delivery.id });
    const sameMeeting = await task("Add screen views to Studio", { source: "meeting", sourceUrl: url });
    // Lisa has one task on each project: neither is clearly hers.
    await task("Answer ETS questions", { personId: lisa.id, projectId: ets.id });
    await task("Plan the delivery handover", { personId: lisa.id, projectId: delivery.id });
    const torn = await task("Pick a time for the call", { personId: lisa.id });
    const none = await task("Buy milk");
    const before = (await fresh(sameMeeting.id)).updatedAt;

    const out = await fillTasks();
    expect(out.projects).toBe(1);

    const filled = await view(sameMeeting.id);
    expect(filled.project.name).toBe("Delivery");
    expect(filled.autoSet).toEqual({ project: "set" });
    expect((await fresh(sameMeeting.id)).updatedAt).toEqual(before);
    expect((await view(torn.id)).project).toBeNull();
    expect((await view(torn.id)).autoSet).toEqual({});
    expect((await view(none.id)).project).toBeNull();
    // The chips are still offered for the one it would not decide.
    expect((await api(`tasks/${torn.id}/project-suggestions`)).body.projects).toHaveLength(2);

    // Looked at within the last day: the next pass does not look again.
    expect((await fillTasks()).looked).toBe(0);
  });

  it("undoes a project for good, and a project Ollie picks himself is no longer OllieOS's", async () => {
    const delivery = await project("Delivery");
    const sales = await project("Sales");
    const url = "https://notes.granola.ai/d/xyz";
    await task("First action", { source: "meeting", sourceUrl: url, projectId: delivery.id });
    const a = await task("Second action", { source: "meeting", sourceUrl: url });
    const b = await task("Third action", { source: "meeting", sourceUrl: url });
    await fillTasks();
    expect((await view(a.id)).autoSet).toEqual({ project: "set" });

    const undone = (await api(`tasks/${a.id}/auto-undo`, { body: { field: "project" } })).body;
    expect(undone.project).toBeNull();
    expect(undone.autoSet).toEqual({ project: "undone" });
    // A day later it is not filled again.
    await db.update(tasksTable).set({ autoCheckedAt: null }).where(eq(tasksTable.id, a.id));
    await fillTasks();
    expect((await view(a.id)).project).toBeNull();
    // Nothing to undo twice, or on a field OllieOS never set.
    expect((await api(`tasks/${a.id}/auto-undo`, { body: { field: "project" } })).status).toBe(400);
    expect((await api(`tasks/${a.id}/auto-undo`, { body: { field: "due" } })).status).toBe(400);

    const mine = (await api(`tasks/${b.id}`, { method: "PATCH", body: { projectId: sales.id } })).body;
    expect(mine.project.name).toBe("Sales");
    expect(mine.autoSet).toEqual({});
  });

  it("sets the reader's due date while it is still ahead, never one in the past, and Undo brings the chip back", async () => {
    const ahead = await task("Send the plan this week", { suggestedDue: addDays(today, 2) });
    const past = await task("Reply urgently", { suggestedDue: addDays(today, -1) });
    const own = await task("Already dated", { dueDate: addDays(today, 5), suggestedDue: addDays(today, 1) });

    expect((await fillTasks()).due).toBe(1);
    const set = await view(ahead.id);
    expect(set.dueDate).toBe(addDays(today, 2));
    expect(set.autoSet).toEqual({ due: "set" });
    expect((await view(past.id)).dueDate).toBeNull();
    expect((await view(past.id)).suggestedDue).toBe(addDays(today, -1));
    expect((await view(own.id)).dueDate).toBe(addDays(today, 5));

    const undone = (await api(`tasks/${ahead.id}/auto-undo`, { body: { field: "due" } })).body;
    expect(undone.dueDate).toBeNull();
    expect(undone.suggestedDue).toBe(addDays(today, 2));
    expect((await fillTasks()).due).toBe(0);

    // Changing the date himself makes it his.
    const again = await task("Another one", { suggestedDue: addDays(today, 3) });
    await fillTasks();
    const moved = (await api(`tasks/${again.id}`, { method: "PATCH", body: { dueDate: addDays(today, 6) } })).body;
    expect(moved.autoSet).toEqual({});
  });

  it("marks the people it links, and an undone link is not put back", async () => {
    const zoe = await person("Zoe Bracegirdle");
    const vova = await person("Vova Tatsakovych");
    const forZoe = await task("Give Zoe a rough figure");
    const waiting = await task("Vova to set up the domain", { status: "waiting" });
    await linkPeopleToTasks();

    expect((await view(forZoe.id)).person.id).toBe(zoe.id);
    expect((await view(forZoe.id)).autoSet).toEqual({ person: "set" });
    expect((await view(waiting.id)).waitingOn.id).toBe(vova.id);
    expect((await view(waiting.id)).autoSet).toEqual({ waitingOn: "set" });

    const undone = (await api(`tasks/${forZoe.id}/auto-undo`, { body: { field: "person" } })).body;
    expect(undone.person).toBeNull();
    await linkPeopleToTasks();
    expect((await view(forZoe.id)).person).toBeNull();
  });

  it("guesses why an item was dropped, saves it only when asked, and Ollie's own choice replaces it", async () => {
    const open = await task("Send Veronica the costs and usage data", { status: "now" });
    const dup = await task("Send Veronica the costs and usage data pack", { status: "dropped", source: "slack" });
    const meeting = await task("Find a time for a call with Sam", { status: "dropped", source: "email" });
    const theirs = await task("Konrad to map the survey codes", { status: "noise", source: "meeting" });
    const done = await task("Confirm the venue", { status: "dropped", source: "slack" });
    await db.insert(taskEvidenceTable).values({ taskId: done.id, source: "slack", sourceRef: "slack:C1:1", saidAt: new Date(), quote: "All confirmed", shows: "done", strength: "other" });
    const unclear = await task("Something about budgets", { status: "dropped", source: "slack" });
    expect(open.id).toBeGreaterThan(0);

    expect(await guessDropReason(dup.id)).toBe("duplicate");
    expect(await guessDropReason(meeting.id)).toBe("arranging");
    expect(await guessDropReason(theirs.id)).toBe("not_mine");
    expect(await guessDropReason(done.id)).toBe("already_done");
    expect(await guessDropReason(unclear.id)).toBeNull();
    // Working out a guess saves nothing.
    expect((await fresh(dup.id)).dropReason).toBeNull();

    const saved = (await api(`tasks/${dup.id}/drop-reason-guess`, { method: "POST" })).body;
    expect(saved.reason).toBe("duplicate");
    expect(saved.task.dropReason).toBe("duplicate");
    expect(saved.task.autoSet).toEqual({ dropReason: "set" });
    // No clear guess: nothing saved, and the chips are left as they were.
    const nothing = (await api(`tasks/${unclear.id}/drop-reason-guess`, { method: "POST" })).body;
    expect(nothing.reason).toBeNull();
    expect(nothing.task.dropReason).toBeNull();
    // An open task is never given a reason.
    expect((await api(`tasks/${open.id}/drop-reason-guess`, { method: "POST" })).body.reason).toBeNull();

    // Ollie picks another reason: it is his, and the review counts it as his.
    const his = (await api(`tasks/${dup.id}`, { method: "PATCH", body: { dropReason: "fyi" } })).body;
    expect(his.dropReason).toBe("fyi");
    expect(his.autoSet).toEqual({});

    await api(`tasks/${meeting.id}/drop-reason-guess`, { method: "POST" });
    const review = await taskReview(7);
    expect(review.filledIn.dropReason).toEqual({ kept: 1, undone: 0 });
  });

  it("learns a sender's usual reason only from reasons Ollie chose himself", async () => {
    const from = { source: "email" as const, fromAddress: "news@vendor.test", status: "dropped" as const };
    await task("Vendor update one", { ...from, dropReason: "fyi" });
    await task("Vendor update two", { ...from, dropReason: "fyi" });
    const next = await task("Quarterly vendor numbers", from);
    expect(await guessDropReason(next.id)).toBe("fyi");

    // Guesses OllieOS made itself do not teach it: two guessed reasons are not a habit.
    const other = { source: "email" as const, fromAddress: "bot@tool.test", status: "dropped" as const };
    await task("Tool digest one", { ...other, dropReason: "not_needed", autoSet: { dropReason: "set" } });
    await task("Tool digest two", { ...other, dropReason: "not_needed", autoSet: { dropReason: "set" } });
    const unknown = await task("Tool numbers for March", other);
    expect(await guessDropReason(unknown.id)).toBeNull();
  });
});
