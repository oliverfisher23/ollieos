/**
 * Plan my day and the Backlog clear-out (build plan 14, Part I).
 *
 * Plan my day: Ollie picks a few tasks, gives each a length, and OllieOS fits them into the gaps
 * between today's meetings inside his working hours. Nothing is written to Google Calendar.
 *
 * Clear-out: every other Monday, Home and the digest offer to go through Backlog tasks that have
 * not changed in 30 days, one at a time.
 */
import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { appSettingsTable, calendarEventsTable, dayPlansTable, db, tasksTable, type PlanItem, type Task as TaskRow } from "@workspace/db";
import { STALE_BACKLOG_DAYS, addDays, daysBetween, londonParts, londonRange, todayLondon, weekStartOf } from "@workspace/shared";
import { ValidationError, updateTask } from "./tasks";
import { toTaskViews, type TaskView } from "./taskView";

/* ---------- Settings ---------- */

const HOURS_KEY = "working_hours";
const CLEAR_OUT_KEY = "backlog_clear_out";

export interface WorkingHours {
  start: string;
  end: string;
}
export const DEFAULT_WORKING_HOURS: WorkingHours = { start: "09:00", end: "18:00" };

async function getSetting<T>(key: string): Promise<T | null> {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, key));
  return row ? (row.value as T) : null;
}

async function putSetting(key: string, value: unknown) {
  await db
    .insert(appSettingsTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettingsTable.key, set: { value, updatedAt: new Date() } });
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
export const toHhmm = (mins: number) => `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;

export async function getWorkingHours(): Promise<WorkingHours> {
  const saved = await getSetting<Partial<WorkingHours>>(HOURS_KEY);
  const start = saved?.start && HHMM.test(saved.start) ? saved.start : DEFAULT_WORKING_HOURS.start;
  const end = saved?.end && HHMM.test(saved.end) ? saved.end : DEFAULT_WORKING_HOURS.end;
  return { start, end };
}

export async function setWorkingHours(hours: WorkingHours): Promise<WorkingHours> {
  if (!HHMM.test(hours.start) || !HHMM.test(hours.end)) throw new ValidationError("Use times such as 09:00");
  if (toMinutes(hours.end) - toMinutes(hours.start) < 60) throw new ValidationError("The working day must end at least an hour after it starts");
  await putSetting(HOURS_KEY, hours);
  return hours;
}

/* ---------- Backlog clear-out ---------- */

/** A Monday that starts a clear-out fortnight. Every other Monday from here is one too. */
const CLEAR_OUT_FIRST_MONDAY = "2026-11-09";

/** The Monday of this week when it is a clear-out week, otherwise null. */
export function clearOutMonday(today: string): string | null {
  const monday = weekStartOf(today);
  const weeks = Math.round(daysBetween(CLEAR_OUT_FIRST_MONDAY, monday) / 7);
  return ((weeks % 2) + 2) % 2 === 0 ? monday : null;
}

/** Backlog tasks nothing has changed on for 30 days, oldest first. Matches the Stale mark. */
function untouchedWhere(now: Date) {
  const cutoff = new Date(now.getTime() - STALE_BACKLOG_DAYS * 86_400_000);
  return and(eq(tasksTable.status, "backlog"), lte(tasksTable.updatedAt, cutoff));
}

export async function untouchedCount(now = new Date()): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(tasksTable).where(untouchedWhere(now));
  return row?.n ?? 0;
}

/** What Home needs: how many are untouched, and whether to offer the clear-out this week. */
export async function clearOutStatus(now = new Date()) {
  const today = todayLondon(now);
  const monday = clearOutMonday(today);
  const [count, saved] = await Promise.all([untouchedCount(now), getSetting<{ dismissed?: string }>(CLEAR_OUT_KEY)]);
  const show = monday != null && count > 0 && saved?.dismissed !== monday;
  return { count, show };
}

export async function getClearOut(now = new Date()) {
  const [status, rows] = await Promise.all([
    clearOutStatus(now),
    db.select().from(tasksTable).where(untouchedWhere(now)).orderBy(asc(tasksTable.updatedAt), asc(tasksTable.id)).limit(200),
  ]);
  return { ...status, tasks: await toTaskViews(rows) };
}

/** Hides this fortnight's clear-out card. It comes back on the next clear-out Monday. */
export async function dismissClearOut(now = new Date()) {
  const monday = clearOutMonday(todayLondon(now)) ?? weekStartOf(todayLondon(now));
  await putSetting(CLEAR_OUT_KEY, { dismissed: monday });
  return clearOutStatus(now);
}

/* ---------- Plan my day ---------- */

export const PLAN_LENGTHS = [15, 30, 60, 120] as const;
const MAX_PLAN_ITEMS = 12;
const SUGGEST_LIMIT = 5;
const PLANNABLE: TaskRow["status"][] = ["inbox", "now", "backlog", "waiting"];

interface Busy {
  start: number;
  end: number;
}

/** Minutes after London midnight on the given date, clamped to the day. */
function minutesOn(date: string, at: Date): number {
  const day = londonRange(date, 1);
  if (at <= day.start) return 0;
  if (at >= day.end) return 24 * 60;
  const p = londonParts(at);
  return p.hour * 60 + p.minute;
}

/**
 * Fits tasks into the gaps between busy times, in the order given, from `from` to `end`.
 * Done tasks keep the time they had. A task that fits nowhere gets no start.
 */
export function fitPlan(items: PlanItem[], doneIds: Set<number>, busy: Busy[], from: number, end: number): PlanItem[] {
  const taken: Busy[] = [...busy];
  for (const it of items) {
    if (doneIds.has(it.taskId) && it.start) taken.push({ start: toMinutes(it.start), end: toMinutes(it.start) + it.minutes });
  }
  taken.sort((a, b) => a.start - b.start);
  return items.map((it) => {
    if (doneIds.has(it.taskId)) return it;
    let at = from;
    for (;;) {
      if (at + it.minutes > end) return { ...it, start: null };
      const clash = taken.find((b) => b.start < at + it.minutes && b.end > at);
      if (!clash) break;
      at = clash.end;
    }
    const placed = { start: at, end: at + it.minutes };
    taken.push(placed);
    taken.sort((a, b) => a.start - b.start);
    return { ...it, start: toHhmm(at) };
  });
}

/** Today's meetings that take up working time; all-day items do not. */
async function meetingsOn(date: string) {
  const day = londonRange(date, 1);
  const rows = await db
    .select()
    .from(calendarEventsTable)
    .where(and(gte(calendarEventsTable.startsAt, day.start), lt(calendarEventsTable.startsAt, day.end)))
    .orderBy(asc(calendarEventsTable.startsAt));
  return rows
    .filter((e) => e.endsAt.getTime() - e.startsAt.getTime() < 20 * 3_600_000)
    .map((e) => ({
      id: e.id,
      title: e.title,
      personal: e.personal,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      start: minutesOn(date, e.startsAt),
      end: Math.max(minutesOn(date, e.startsAt) + 1, minutesOn(date, e.endsAt)),
    }));
}

/** Now, rounded up to the next quarter hour, in minutes after midnight. */
function nowRounded(now: Date): number {
  const p = londonParts(now);
  return Math.ceil((p.hour * 60 + p.minute) / 15) * 15;
}

async function loadPlan(date: string): Promise<PlanItem[] | null> {
  const [row] = await db.select().from(dayPlansTable).where(eq(dayPlansTable.date, date));
  return row ? row.items : null;
}

function reasonFor(t: TaskView, today: string): string {
  if (t.dueDate && t.dueDate < today) return t.kind === "promise" ? "Promise, overdue" : "Overdue";
  if (t.dueDate === today) return t.kind === "promise" ? "Promise, due today" : "Due today";
  if (t.status === "now") return t.priority === "high" ? "In Now, high priority" : "In Now";
  if (t.priority === "high") return "High priority";
  return "Suggested";
}

/**
 * Up to five open tasks worth doing today: overdue, due today, Now, then high priority. Within overdue
 * and due today, promises come first (section 30, Part E): something Ollie told someone he would do
 * outranks a task of the same age.
 */
async function suggestFor(today: string, now: Date, exclude: Set<number>): Promise<TaskView[]> {
  const rows = await db
    .select()
    .from(tasksTable)
    .where(
      and(
        inArray(tasksTable.status, ["now", "backlog", "waiting"]),
        sql`(${tasksTable.snoozedUntil} is null or ${tasksTable.snoozedUntil} <= ${now.toISOString()})`,
        sql`((${tasksTable.dueDate} is not null and ${tasksTable.dueDate} <= ${today}) or ${tasksTable.status} = 'now' or ${tasksTable.priority} = 'high')`,
      ),
    )
    .orderBy(
      sql`case when ${tasksTable.dueDate} < ${today} then 0 when ${tasksTable.dueDate} = ${today} then 1 when ${tasksTable.status} = 'now' then 2 else 3 end`,
      sql`case when ${tasksTable.dueDate} <= ${today} and ${tasksTable.kind} = 'promise' then 0 else 1 end`,
      sql`case ${tasksTable.priority} when 'high' then 0 when 'medium' then 1 else 2 end`,
      sql`${tasksTable.dueDate} asc nulls last`,
      asc(tasksTable.createdAt),
    )
    .limit(40);
  // Waiting on someone else is only worth planning when it is due.
  const picked = rows.filter((r) => !exclude.has(r.id) && (r.status !== "waiting" || (r.dueDate != null && r.dueDate <= today)));
  return toTaskViews(picked.slice(0, SUGGEST_LIMIT));
}

/** The most recent earlier plan's tasks that are still open, offered again today. */
async function carryOvers(today: string): Promise<TaskView[]> {
  const [prev] = await db
    .select()
    .from(dayPlansTable)
    .where(and(lt(dayPlansTable.date, today), gte(dayPlansTable.date, addDays(today, -7))))
    .orderBy(desc(dayPlansTable.date))
    .limit(1);
  if (!prev?.items.length) return [];
  const ids = prev.items.map((i) => i.taskId);
  const rows = await db.select().from(tasksTable).where(and(inArray(tasksTable.id, ids), inArray(tasksTable.status, PLANNABLE)));
  const order = new Map(ids.map((id, i) => [id, i]));
  rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return toTaskViews(rows);
}

export async function getPlan(now = new Date()) {
  const date = todayLondon(now);
  const [hours, meetings, saved] = await Promise.all([getWorkingHours(), meetingsOn(date), loadPlan(date)]);
  const items = saved ?? [];
  const rows = items.length ? await db.select().from(tasksTable).where(inArray(tasksTable.id, items.map((i) => i.taskId))) : [];
  const views = new Map((await toTaskViews(rows)).map((t) => [t.id, t]));

  const planned = items
    .filter((i) => views.has(i.taskId))
    .map((i) => {
      const task = views.get(i.taskId)!;
      const start = i.start ? toMinutes(i.start) : null;
      const end = start != null ? start + i.minutes : null;
      const clash = start != null && end != null && meetings.some((m) => m.start < end && m.end > start);
      return { task, minutes: i.minutes, start: i.start, end: end != null ? toHhmm(Math.min(end, 24 * 60 - 1)) : null, clash };
    });

  const inPlan = new Set(planned.map((p) => p.task.id));
  // Suggestions are only needed while there is no plan yet.
  const [carried, suggested] = saved
    ? [[], []]
    : await Promise.all([carryOvers(date), suggestFor(date, now, inPlan)]);
  const carriedIds = new Set(carried.map((t) => t.id));
  const suggestions = [
    ...carried.map((task) => ({ task, reason: "Not finished yesterday", carriedOver: true })),
    ...suggested.filter((t) => !carriedIds.has(t.id)).map((task) => ({ task, reason: reasonFor(task, date), carriedOver: false })),
  ].slice(0, Math.max(SUGGEST_LIMIT, carried.length));

  return {
    date,
    workingHours: hours,
    made: saved != null,
    items: planned,
    meetings: meetings.map((m) => ({ id: m.id, title: m.title, personal: m.personal, startsAt: m.startsAt, endsAt: m.endsAt })),
    suggestions,
  };
}

/**
 * Saves today's plan and fits it around the meetings, from now (or the start of the day) onwards.
 * A Backlog or Inbox task newly put in the plan moves to Now (section 30, Part E, agreed 13th November
 * 2026), so Now always matches the day's plan. One already in the plan is left where Ollie has since put it.
 */
export async function savePlan(input: { taskId: number; minutes: number }[], now = new Date(), actor = "ollie") {
  if (input.length > MAX_PLAN_ITEMS) throw new ValidationError(`Plan up to ${MAX_PLAN_ITEMS} tasks a day`);
  const seen = new Set<number>();
  for (const i of input) {
    if (!(PLAN_LENGTHS as readonly number[]).includes(i.minutes)) throw new ValidationError("Lengths are 15, 30, 60 or 120 minutes");
    if (seen.has(i.taskId)) throw new ValidationError("A task can only be in the plan once");
    seen.add(i.taskId);
  }
  const date = todayLondon(now);
  const ids = input.map((i) => i.taskId);
  const rows = ids.length ? await db.select({ id: tasksTable.id, status: tasksTable.status }).from(tasksTable).where(inArray(tasksTable.id, ids)) : [];
  if (rows.length !== ids.length) throw new ValidationError("One of those tasks no longer exists");
  const doneIds = new Set(rows.filter((r) => r.status === "done").map((r) => r.id));
  // Dropped, archived or noise since it was planned: it simply leaves the plan.
  const keep = new Set(rows.filter((r) => r.status === "done" || PLANNABLE.includes(r.status)).map((r) => r.id));
  input = input.filter((i) => keep.has(i.taskId));

  const [hours, meetings, saved] = await Promise.all([getWorkingHours(), meetingsOn(date), loadPlan(date)]);
  const before = new Map((saved ?? []).map((i) => [i.taskId, i]));
  const items: PlanItem[] = input.map((i) => ({ taskId: i.taskId, minutes: i.minutes, start: before.get(i.taskId)?.start ?? null }));
  const from = Math.max(toMinutes(hours.start), nowRounded(now));
  const fitted = fitPlan(items, doneIds, meetings, from, toMinutes(hours.end));

  await db
    .insert(dayPlansTable)
    .values({ date, items: fitted })
    .onConflictDoUpdate({ target: dayPlansTable.date, set: { items: fitted, updatedAt: new Date() } });
  const toNow = rows.filter((r) => (r.status === "backlog" || r.status === "inbox") && keep.has(r.id) && !before.has(r.id));
  for (const r of toNow) await updateTask(r.id, { status: "now" }, actor);
  return getPlan(now);
}

/** "Fit again": keeps the same tasks and lengths and fits them around the meetings from now. */
export async function refitPlan(now = new Date()) {
  const saved = (await loadPlan(todayLondon(now))) ?? [];
  const rows = saved.length ? await db.select({ id: tasksTable.id }).from(tasksTable).where(inArray(tasksTable.id, saved.map((i) => i.taskId))) : [];
  const exists = new Set(rows.map((r) => r.id));
  return savePlan(saved.filter((i) => exists.has(i.taskId)).map((i) => ({ taskId: i.taskId, minutes: i.minutes })), now);
}
