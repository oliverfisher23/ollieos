import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { calendarEventsTable, db, tasksTable } from "@workspace/db";
import { addDays, buildRepeat, londonWallTimeToInstant, nextRepeatDate, repeatLabel, todayLondon } from "@workspace/shared";
import { buildDigest } from "../src/services/digest";
import { clearOutMonday, fitPlan, getPlan, savePlan } from "../src/services/planning";
import { api, call, connect, mcp, useServer } from "./harness";

vi.mock("../src/services/ask/model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/ask/model")>()),
  digestSummaryFromLines: async () => "Overnight things moved.",
}));

useServer();

const today = todayLondon();

async function newTask(body: Record<string, unknown> = {}) {
  const t = (await api("tasks/quick-add", { body: { text: "Send the monthly report #backlog" } })).body.task;
  if (Object.keys(body).length) return (await api(`tasks/${t.id}`, { method: "PATCH", body })).body;
  return t;
}

async function allTasks() {
  return db.select().from(tasksTable).orderBy(tasksTable.id);
}

describe("Repeat dates", () => {
  it("works out the next date for each kind of repeat", () => {
    // Tuesday 10th November 2026.
    const d = "2026-11-10";
    const next = (every: Parameters<typeof buildRepeat>[0], byWd = false) => nextRepeatDate(buildRepeat(every, d, byWd), d, d);
    expect(next("day")).toBe("2026-11-11");
    expect(next("week")).toBe("2026-11-17");
    expect(next("fortnight")).toBe("2026-11-24");
    expect(next("month")).toBe("2026-12-10");
    expect(next("month", true)).toBe("2026-12-08");
    expect(next("quarter")).toBe("2027-02-10");
    expect(next("year")).toBe("2027-11-10");
    // Friday to Monday for weekdays.
    expect(nextRepeatDate(buildRepeat("weekday", "2026-11-13"), "2026-11-13", "2026-11-13")).toBe("2026-11-16");
  });

  it("keeps the 31st through short months and handles the last weekday", () => {
    const rule = buildRepeat("month", "2027-01-31");
    expect(nextRepeatDate(rule, "2027-01-31", "2027-01-31")).toBe("2027-02-28");
    expect(nextRepeatDate(rule, "2027-02-28", "2027-02-28")).toBe("2027-03-31");
    // Monday 30th November 2026 is the last Monday.
    const last = buildRepeat("month", "2026-11-30", true);
    expect(last).toMatchObject({ nth: 5, weekday: 1 });
    expect(repeatLabel(last)).toBe("Every month on the last Monday");
    expect(nextRepeatDate(last, "2026-11-30", "2026-11-30")).toBe("2026-12-28");
  });

  it("skips dates already gone when ticked off late", () => {
    const rule = buildRepeat("week", "2026-11-02");
    expect(nextRepeatDate(rule, "2026-11-02", "2026-11-18")).toBe("2026-11-23");
  });
});

describe("Repeating tasks", () => {
  it("makes the next copy once when ticked off, and takes it back on undo", async () => {
    const t = await newTask({ repeat: { every: "month" } });
    // No due date, so it is anchored on today.
    expect(t.dueDate).toBe(today);
    expect(t.repeat).toMatchObject({ every: "month", day: Number(today.slice(8)) });
    await api(`tasks/${t.id}`, { method: "PATCH", body: { steps: [{ id: "a", title: "Pull the numbers", done: true }, { id: "b", title: "Write it up", done: false }] } });

    await api(`tasks/${t.id}`, { method: "PATCH", body: { status: "done" } });
    let rows = await allTasks();
    expect(rows).toHaveLength(2);
    const copy = rows[1];
    expect(copy).toMatchObject({ title: t.title, status: "backlog", dueDate: nextRepeatDate(t.repeat, today, today) });
    expect(copy.steps.map((s) => s.done)).toEqual([false, false]);
    expect(copy.repeat).toEqual(t.repeat);

    // Ticking off again does not make another copy.
    await api(`tasks/${t.id}`, { method: "PATCH", body: { status: "now" } });
    rows = await allTasks();
    expect(rows).toHaveLength(1);
    await api(`tasks/${t.id}`, { method: "PATCH", body: { status: "done" } });
    expect(await allTasks()).toHaveLength(2);
    expect((await api(`tasks/${t.id}/undo`, { body: {} })).status).toBe(200);
    expect(await allTasks()).toHaveLength(1);

    const history = (await api(`tasks/${t.id}`)).body.history.map((h: { summary: string }) => h.summary);
    expect(history.some((s: string) => s.includes("Repeats: Every month on the"))).toBe(true);
    expect(history).toContain("Checklist updated (1 of 2 done)");
  });

  it("keeps a copy that has been touched when the tick is taken back", async () => {
    const t = await newTask({ repeat: { every: "week" } });
    await api(`tasks/${t.id}`, { method: "PATCH", body: { status: "done" } });
    const copy = (await allTasks())[1];
    await new Promise((r) => setTimeout(r, 2100));
    await api(`tasks/${copy.id}`, { method: "PATCH", body: { priority: "high" } });
    await api(`tasks/${t.id}`, { method: "PATCH", body: { status: "now" } });
    expect(await allTasks()).toHaveLength(2);
  });

  it("re-anchors on a new due date, stops, and offers to carry on after a drop", async () => {
    const t = await newTask({ repeat: { every: "week" }, dueDate: "2026-11-12" });
    expect(t.repeat).toEqual({ every: "week", weekday: 4 });
    const moved = (await api(`tasks/${t.id}`, { method: "PATCH", body: { dueDate: "2026-11-16" } })).body;
    expect(moved.repeat).toEqual({ every: "week", weekday: 1 });

    await api(`tasks/${t.id}`, { method: "PATCH", body: { status: "dropped" } });
    expect(await allTasks()).toHaveLength(1);
    expect((await api(`tasks/${t.id}/continue-repeat`, { body: {} })).status).toBe(200);
    expect(await allTasks()).toHaveLength(2);
    expect((await api(`tasks/${t.id}/continue-repeat`, { body: {} })).status).toBe(409);

    const stopped = (await api(`tasks/${t.id}`, { method: "PATCH", body: { repeat: null } })).body;
    expect(stopped.repeat).toBeNull();
  });
});

describe("Checklists", () => {
  it("cleans steps and rejects too many", async () => {
    const t = await newTask();
    const res = (await api(`tasks/${t.id}`, { method: "PATCH", body: { steps: [{ id: "x", title: "  One ", done: false }, { id: "x", title: "Two", done: false }, { id: "y", title: "   ", done: false }] } })).body;
    expect(res.steps.map((s: { title: string }) => s.title)).toEqual(["One", "Two"]);
    expect(new Set(res.steps.map((s: { id: string }) => s.id)).size).toBe(2);
    const many = Array.from({ length: 51 }, (_, i) => ({ id: `s${i}`, title: `Step ${i}`, done: false }));
    expect((await api(`tasks/${t.id}`, { method: "PATCH", body: { steps: many } })).status).toBe(400);
  });

  it("lets Claude add steps when capturing, and shows repeats and steps", async () => {
    const c = await mcp((await connect()).access_token);
    const out = await call(c, "create_task", { title: "Prepare the board pack", steps: ["Draft", "Review"] });
    const task = out.json.task as { ref: string; steps: { title: string; done: boolean }[]; repeats: string | null };
    expect(task.steps).toEqual([{ title: "Draft", done: false }, { title: "Review", done: false }]);
    expect(task.repeats).toBeNull();
    const id = Number(task.ref.split(":")[1]);
    await api(`tasks/${id}`, { method: "PATCH", body: { repeat: { every: "quarter" }, dueDate: "2026-12-01" } });
    const read = await call(c, "update_task", { ref: task.ref, status: "archived" });
    expect((read.json.task as { repeats: string; status: string })).toMatchObject({ repeats: "Every quarter on the 1st", status: "archived" });
  });
});

describe("Archived", () => {
  it("has its own tab, is left out of open counts, and restores to the Backlog", async () => {
    const t = await newTask({ status: "archived" });
    const summary = (await api("tasks/summary")).body;
    expect(summary.tabs).toMatchObject({ archived: 1, open: 0, backlog: 0 });
    expect((await api("tasks?tab=archived")).body.map((x: { id: number }) => x.id)).toEqual([t.id]);
    expect((await api("tasks?tab=open")).body).toEqual([]);
    expect((await api("tasks?tab=archived&q=monthly")).body).toHaveLength(1);
    const back = (await api(`tasks/${t.id}/restore`, { body: {} })).body;
    expect(back.status).toBe("backlog");
    const history = (await api(`tasks/${t.id}`)).body.history.map((h: { summary: string }) => h.summary);
    expect(history[0]).toBe("Restored from Archived to Backlog");
  });
});

describe("Backlog clear-out", () => {
  it("lists untouched Backlog tasks, keeps one, and shows on a clear-out Monday", async () => {
    const old = await newTask();
    const fresh = await newTask();
    await db.update(tasksTable).set({ updatedAt: sql`now() - interval '40 days'` }).where(eq(tasksTable.id, old.id));

    const list = (await api("backlog/clear-out")).body;
    expect(list.count).toBe(1);
    expect(list.tasks.map((x: { id: number }) => x.id)).toEqual([old.id]);
    expect(list.show).toBe(clearOutMonday(today) != null);

    expect((await api(`backlog/clear-out/${old.id}/keep`, { body: {} })).status).toBe(200);
    expect((await api("backlog/clear-out")).body.count).toBe(0);
    expect((await api(`backlog/clear-out/${fresh.id}/keep`, { body: {} })).status).toBe(200);
    await api(`tasks/${fresh.id}`, { method: "PATCH", body: { status: "now" } });
    expect((await api(`backlog/clear-out/${fresh.id}/keep`, { body: {} })).status).toBe(409);
  });

  it("can be put away until the next clear-out Monday", async () => {
    const old = await newTask();
    await db.update(tasksTable).set({ updatedAt: sql`now() - interval '40 days'` }).where(eq(tasksTable.id, old.id));
    const after = (await api("backlog/clear-out/dismiss", { body: {} })).body;
    expect(after).toEqual({ count: 1, show: false });
  });

  it("runs every other Monday and goes in the digest that day", async () => {
    expect(clearOutMonday("2026-11-09")).toBe("2026-11-09");
    expect(clearOutMonday("2026-11-13")).toBe("2026-11-09");
    expect(clearOutMonday("2026-11-16")).toBeNull();
    expect(clearOutMonday("2026-11-23")).toBe("2026-11-23");

    const old = await newTask();
    await db.update(tasksTable).set({ updatedAt: sql`now() - interval '40 days'` }).where(eq(tasksTable.id, old.id));
    const monday = clearOutMonday(today) ?? addDays(clearOutMonday(addDays(today, 7))!, 0);
    const digest = await buildDigest(monday);
    const texts = (digest.sections.needs?.items ?? []).map((i: { text: string }) => i.text);
    expect(texts).toContain("Clear out your Backlog: 1 untouched for 30 days or more");
  });
});

describe("Plan my day", () => {
  it("fits tasks between meetings inside working hours", () => {
    const busy = [{ start: 10 * 60, end: 11 * 60 }, { start: 11 * 60 + 30, end: 12 * 60 }];
    const out = fitPlan(
      [
        { taskId: 1, minutes: 60, start: null },
        { taskId: 2, minutes: 30, start: null },
        { taskId: 3, minutes: 60, start: null },
        { taskId: 4, minutes: 120, start: null },
      ],
      new Set(),
      busy,
      9 * 60,
      14 * 60,
    );
    expect(out.map((i) => i.start)).toEqual(["09:00", "11:00", "12:00", null]);
  });

  it("keeps done tasks where they were and fits the rest around them", () => {
    const out = fitPlan(
      [
        { taskId: 1, minutes: 30, start: "09:00" },
        { taskId: 2, minutes: 30, start: "09:30" },
      ],
      new Set([1]),
      [],
      9 * 60,
      18 * 60,
    );
    expect(out).toEqual([
      { taskId: 1, minutes: 30, start: "09:00" },
      { taskId: 2, minutes: 30, start: "09:30" },
    ]);
  });

  it("suggests tasks, saves a plan around a meeting, and checks the inputs", async () => {
    const due = await newTask({ dueDate: today, status: "now" });
    const high = await newTask({ priority: "high" });
    await newTask(); // Medium, no date: not suggested.
    const early = new Date(londonWallTimeToInstant(today, 7, 0));
    await db.insert(calendarEventsTable).values({
      sourceRef: "evt-1",
      title: "Team meeting",
      startsAt: londonWallTimeToInstant(today, 9, 30),
      endsAt: londonWallTimeToInstant(today, 10, 30),
    });

    const empty = await getPlan(early);
    expect(empty.made).toBe(false);
    expect(empty.suggestions.map((s) => s.task.id)).toEqual([due.id, high.id]);
    expect(empty.suggestions[0].reason).toBe("Due today");
    expect(empty.meetings.map((m) => m.title)).toEqual(["Team meeting"]);

    const plan = await savePlan(
      [
        { taskId: due.id, minutes: 60 },
        { taskId: high.id, minutes: 30 },
      ],
      early,
    );
    expect(plan.made).toBe(true);
    expect(plan.suggestions).toEqual([]);
    expect(plan.items.map((i) => [i.start, i.end])).toEqual([
      ["10:30", "11:30"],
      ["09:00", "09:30"],
    ]);

    expect((await api("plan", { method: "PUT", body: { items: [{ taskId: due.id, minutes: 45 }] } })).status).toBe(400);
    expect((await api("settings/working-hours", { method: "PUT", body: { start: "10:00", end: "10:30" } })).status).toBe(400);
    expect((await api("settings/working-hours", { method: "PUT", body: { start: "08:00", end: "17:00" } })).body).toEqual({ start: "08:00", end: "17:00" });
  });

  it("offers yesterday's unfinished tasks first", async () => {
    const left = await newTask();
    const finished = await newTask();
    await api(`tasks/${finished.id}`, { method: "PATCH", body: { status: "done" } });
    await db.execute(
      sql`insert into day_plans (date, items) values (${addDays(today, -1)}, ${JSON.stringify([
        { taskId: left.id, minutes: 30, start: "09:00" },
        { taskId: finished.id, minutes: 30, start: "09:30" },
      ])}::jsonb)`,
    );
    const plan = (await api("plan")).body;
    expect(plan.suggestions[0]).toMatchObject({ carriedOver: true, reason: "Not finished yesterday" });
    expect(plan.suggestions.map((s: { task: { id: number } }) => s.task.id)).toEqual([left.id]);
  });
});
