/**
 * Time and meetings (build plan section 19, Part R).
 *
 * - Meeting history: every work meeting Ollie went to, written when it ends and kept 2 years, with
 *   what Granola notes made of it. A one-off backfill reads the last 12 weeks from Google Calendar.
 * - Where my time goes: meeting hours by goal, function and internal or external, this week and the
 *   four before, with planned task time from Plan my day beside it.
 * - Is this week realistic: free working hours left this week against what is due, at each task's
 *   Plan my day length (30 minutes when none is set). Over 80% means a warning with tasks that
 *   could move. OllieOS never moves anything itself.
 * - Meetings worth keeping: repeating meetings where 3 of the last 4 brought no actions or decisions.
 */
import { and, asc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import {
  appSettingsTable,
  calendarEventsTable,
  dayPlansTable,
  db,
  goalsTable,
  meetingHistoryTable,
  projectsTable,
  tasksTable,
  type CalendarEvent,
} from "@workspace/db";
import { OPEN_STATUSES, addDays, londonRange, londonWallTimeToInstant, todayLondon, weekday } from "@workspace/shared";
import { logger } from "../lib/logger";
import type { CalendarInput } from "./aiWrites";
import { loadMatchers, matchEvent } from "./briefs";
import { getWorkingHours } from "./planning";
import { toTaskViews, type TaskView } from "./taskView";

const HOUR = 3_600_000;
const DAY = 86_400_000;
export const KEEP_YEARS = 2;
export const BACKFILL_WEEKS = 12;
const BACKFILL_KEY = "meeting_history_backfill";
const KEPT_KEY = "meetings_worth_keeping_kept";
/** Warn when what is due is more than this share of the free time left (question 57). */
export const OVER_SHARE = 0.8;
export const DEFAULT_TASK_MINUTES = 30;

/* ---------- Meeting history ---------- */

type EventLike = Pick<CalendarEvent, "sourceRef" | "title" | "startsAt" | "endsAt" | "attendees" | "attendeeDetails" | "personal" | "personIds" | "projectId"> & { recurringEventId?: string | null };

/** Records meetings that have ended (non-personal, under 20 hours). Returns how many were new. */
export async function recordHistory(events: EventLike[], now = new Date()): Promise<number> {
  const ended = events.filter((e) => !e.personal && e.endsAt <= now && e.endsAt.getTime() - e.startsAt.getTime() < 20 * HOUR);
  if (!ended.length) return 0;
  const existing = new Set(
    (await db.select({ ref: meetingHistoryTable.sourceRef }).from(meetingHistoryTable).where(inArray(meetingHistoryTable.sourceRef, ended.map((e) => e.sourceRef)))).map((r) => r.ref),
  );
  const fresh = ended.filter((e) => !existing.has(e.sourceRef));
  if (!fresh.length) return 0;
  const m = await loadMatchers();
  const matches = fresh.map((e) => matchEvent({ id: 0, location: null, platform: null, updatedAt: now, ...e } as unknown as CalendarEvent, m));
  const projectIds = [...new Set(matches.flatMap((x) => x.projectIds.slice(0, 1)))];
  const projects = projectIds.length
    ? await db.select({ id: projectsTable.id, goalId: projectsTable.goalId, fn: projectsTable.function }).from(projectsTable).where(inArray(projectsTable.id, projectIds))
    : [];
  const byProject = new Map(projects.map((p) => [p.id, p]));
  const rows = fresh.map((e, i) => {
    const x = matches[i];
    const pid = x.projectIds[0] ?? null;
    const p = pid != null ? byProject.get(pid) : undefined;
    return {
      sourceRef: e.sourceRef,
      seriesId: e.recurringEventId ?? null,
      title: e.title,
      startsAt: e.startsAt,
      minutes: Math.max(1, Math.round((e.endsAt.getTime() - e.startsAt.getTime()) / 60_000)),
      scope: x.scope,
      projectId: pid,
      goalId: p?.goalId ?? null,
      businessFunction: p?.fn ?? null,
      orgIds: x.orgIds,
      personIds: x.personIds,
      organiser: (e.attendeeDetails ?? []).find((a) => a.organiser)?.email ?? null,
    };
  });
  const made = await db.insert(meetingHistoryTable).values(rows).onConflictDoNothing().returning({ id: meetingHistoryTable.id });
  return made.length;
}

/** Records what the Granola notes made of a meeting. */
export async function markHistoryNotes(sourceRef: string, actions: number, decisions: number): Promise<void> {
  await db.update(meetingHistoryTable).set({ hadNotes: true, actions, decisions }).where(eq(meetingHistoryTable.sourceRef, sourceRef));
}

/** On each Calendar check: meetings that ended go into history, and the 12-week backfill runs once. */
export async function historyFromCalendar(now = new Date()): Promise<{ recorded: number; backfilled: number }> {
  const recent = await db
    .select()
    .from(calendarEventsTable)
    .where(and(lte(calendarEventsTable.endsAt, now), gte(calendarEventsTable.endsAt, new Date(now.getTime() - 30 * DAY))));
  const recorded = await recordHistory(recent, now);
  let backfilled = 0;
  const [flag] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, BACKFILL_KEY));
  if (!flag) {
    try {
      const { readGoogleCalendarRange } = await import("./connectors/googleCalendar");
      const r = await readGoogleCalendarRange({ start: new Date(now.getTime() - BACKFILL_WEEKS * 7 * DAY), end: now });
      backfilled = await recordHistory(r.events as (CalendarInput & EventLike)[], now);
      await db.insert(appSettingsTable).values({ key: BACKFILL_KEY, value: { at: now.toISOString(), weeks: BACKFILL_WEEKS, meetings: backfilled } }).onConflictDoNothing();
    } catch (err) {
      logger.warn({ err }, "Could not backfill meeting history; the next Calendar check tries again");
    }
  }
  return { recorded, backfilled };
}

export async function clearOldHistory(now = new Date()): Promise<number> {
  const rows = await db.delete(meetingHistoryTable).where(lt(meetingHistoryTable.startsAt, new Date(now.getTime() - KEEP_YEARS * 365 * DAY))).returning({ id: meetingHistoryTable.id });
  return rows.length;
}

/* ---------- Where my time goes ---------- */

export interface TimeSlice {
  key: string;
  label: string;
  hours: number;
}

export interface TimeWeek {
  /** Monday of the week */
  weekStart: string;
  meetingHours: number;
  byGoal: TimeSlice[];
  byFunction: TimeSlice[];
  internalHours: number;
  externalHours: number;
  /** Planned task time from Plan my day, for tasks ticked off */
  plannedTaskHours: number;
}

export interface TimeReport {
  weeks: TimeWeek[];
  /** Top-level goals with under 10% of this week's meeting time */
  thinGoals: string[];
}

const mondayOf = (date: string) => addDays(date, -((weekday(date) + 6) % 7));
const round1 = (n: number) => Math.round(n * 10) / 10;
const FUNCTION_LABEL: Record<string, string> = { delivery: "Delivery", product: "Product", sales: "Sales", marketing: "Marketing" };

export async function timeReport(now = new Date(), weeks = 5): Promise<TimeReport> {
  const thisMonday = mondayOf(todayLondon(now));
  const firstMonday = addDays(thisMonday, -7 * (weeks - 1));
  const start = londonRange(firstMonday, 1).start;
  const [rows, goals, plans] = await Promise.all([
    db.select().from(meetingHistoryTable).where(and(gte(meetingHistoryTable.startsAt, start), lt(meetingHistoryTable.startsAt, now))),
    db.select({ id: goalsTable.id, name: goalsTable.name, parentId: goalsTable.parentId }).from(goalsTable),
    db.select().from(dayPlansTable).where(gte(dayPlansTable.date, firstMonday)),
  ]);
  const goalName = new Map(goals.map((g) => [g.id, g.name]));
  const planTaskIds = [...new Set(plans.flatMap((p) => p.items.map((i) => i.taskId)))];
  const done = planTaskIds.length
    ? new Set((await db.select({ id: tasksTable.id }).from(tasksTable).where(and(inArray(tasksTable.id, planTaskIds), eq(tasksTable.status, "done")))).map((t) => t.id))
    : new Set<number>();

  const out: TimeWeek[] = [];
  for (let w = 0; w < weeks; w++) {
    const monday = addDays(thisMonday, -7 * w);
    const range = londonRange(monday, 7);
    const inWeek = rows.filter((r) => r.startsAt >= range.start && r.startsAt < range.end);
    const goalHours = new Map<string, number>();
    const fnHours = new Map<string, number>();
    let internal = 0;
    let external = 0;
    for (const r of inWeek) {
      const h = r.minutes / 60;
      const g = r.goalId != null && goalName.has(r.goalId) ? String(r.goalId) : "none";
      goalHours.set(g, (goalHours.get(g) ?? 0) + h);
      const f = r.businessFunction ?? "none";
      fnHours.set(f, (fnHours.get(f) ?? 0) + h);
      if (r.scope === "external") external += h;
      else internal += h;
    }
    const slices = (m: Map<string, number>, label: (k: string) => string) =>
      [...m.entries()]
        .map(([key, hours]) => ({ key, label: key === "none" ? "Not linked" : label(key), hours: round1(hours) }))
        .sort((a, b) => Number(a.key === "none") - Number(b.key === "none") || b.hours - a.hours);
    const planned = plans
      .filter((p) => p.date >= monday && p.date < addDays(monday, 7))
      .flatMap((p) => p.items)
      .filter((i) => done.has(i.taskId))
      .reduce((n, i) => n + i.minutes / 60, 0);
    out.push({
      weekStart: monday,
      meetingHours: round1(inWeek.reduce((n, r) => n + r.minutes / 60, 0)),
      byGoal: slices(goalHours, (k) => goalName.get(Number(k)) ?? "A goal"),
      byFunction: slices(fnHours, (k) => FUNCTION_LABEL[k] ?? k),
      internalHours: round1(internal),
      externalHours: round1(external),
      plannedTaskHours: round1(planned),
    });
  }
  const cur = out[0];
  const thinGoals = cur.meetingHours
    ? goals
        .filter((g) => g.parentId == null)
        .filter((g) => (cur.byGoal.find((s) => s.key === String(g.id))?.hours ?? 0) < cur.meetingHours * 0.1)
        .map((g) => g.name)
    : [];
  return { weeks: out, thinGoals };
}

/** "18 hours in meetings, 7 towards Growth", for the weekly round-up. */
export async function weekTimeLine(end: Date): Promise<string | null> {
  const r = await timeReport(end, 1);
  const w = r.weeks[0];
  if (!w.meetingHours) return null;
  const top = w.byGoal.find((s) => s.key !== "none");
  return `${w.meetingHours} hours in meetings${top ? `, ${top.hours} towards ${top.label}` : ""}${w.plannedTaskHours ? `, and ${w.plannedTaskHours} hours of planned task time ticked off` : ""}`;
}

/* ---------- Is this week realistic? ---------- */

export interface WeekCheck {
  freeHours: number;
  dueHours: number;
  /** Hours more than fits, 0 when it fits */
  overBy: number;
  over: boolean;
  /** Tasks that could move: Medium or Low, not promises, no one waiting on them */
  movable: TaskView[];
  dueCount: number;
}

export async function weekCheck(now = new Date()): Promise<WeekCheck> {
  const today = todayLondon(now);
  const friday = addDays(mondayOf(today), 4);
  const hours = await getWorkingHours();
  const [sh, sm] = hours.start.split(":").map(Number);
  const [eh, em] = hours.end.split(":").map(Number);

  // Free working time from now to the end of Friday, less meetings.
  const rangeStart = now;
  const rangeEnd = londonWallTimeToInstant(friday, eh, em);
  const events = await db
    .select()
    .from(calendarEventsTable)
    .where(and(lt(calendarEventsTable.startsAt, rangeEnd), gte(calendarEventsTable.endsAt, rangeStart)))
    .orderBy(asc(calendarEventsTable.startsAt));
  let free = 0;
  for (let d = today; d <= friday; d = addDays(d, 1)) {
    if ([0, 6].includes(weekday(d))) continue;
    const ws = Math.max(londonWallTimeToInstant(d, sh, sm).getTime(), rangeStart.getTime());
    const we = londonWallTimeToInstant(d, eh, em).getTime();
    if (we <= ws) continue;
    let busy = 0;
    for (const e of events) {
      if (e.endsAt.getTime() - e.startsAt.getTime() >= 20 * HOUR) continue;
      busy += Math.max(0, Math.min(we, e.endsAt.getTime()) - Math.max(ws, e.startsAt.getTime()));
    }
    free += Math.max(0, we - ws - busy);
  }

  // Due this week: open tasks due by Friday, Now tasks, and promises due by Friday.
  const due = await db
    .select()
    .from(tasksTable)
    .where(and(inArray(tasksTable.status, [...OPEN_STATUSES].filter((s) => s !== "inbox" && s !== "waiting")), sql`(${tasksTable.status} = 'now' or (${tasksTable.dueDate} is not null and ${tasksTable.dueDate} <= ${friday}))`));
  const plans = await db.select().from(dayPlansTable).where(gte(dayPlansTable.date, addDays(today, -14)));
  const planned = new Map<number, number>();
  for (const p of plans) for (const i of p.items) planned.set(i.taskId, i.minutes);
  const dueMinutes = due.reduce((n, t) => n + (planned.get(t.id) ?? DEFAULT_TASK_MINUTES), 0);
  const freeHours = round1(free / HOUR);
  const dueHours = round1(dueMinutes / 60);
  const over = dueHours > freeHours * OVER_SHARE;
  const movableRows = due.filter((t) => t.kind !== "promise" && t.priority !== "high" && t.personId == null && t.waitingOnPersonId == null && t.status !== "waiting");
  return {
    freeHours,
    dueHours,
    overBy: over ? round1(Math.max(0, dueHours - freeHours * OVER_SHARE)) : 0,
    over,
    movable: over ? (await toTaskViews(movableRows)).slice(0, 8) : [],
    dueCount: due.length,
  };
}

/* ---------- Meetings worth keeping ---------- */

export interface WorthALook {
  seriesId: string;
  title: string;
  /** "weekly", "every 2 weeks" or "about N a month" */
  howOften: string;
  hoursAMonth: number;
  /** Of the last 4: how many had notes, and what came out */
  lastFour: { notes: number; actions: number; decisions: number };
  organiser: string | null;
  /** A short note to the organiser, for copying */
  note: string;
}

export async function worthALook(now = new Date()): Promise<WorthALook[]> {
  const since = new Date(now.getTime() - 56 * DAY);
  const rows = await db
    .select()
    .from(meetingHistoryTable)
    .where(and(gte(meetingHistoryTable.startsAt, since), sql`${meetingHistoryTable.seriesId} is not null`))
    .orderBy(asc(meetingHistoryTable.startsAt));
  const [keptRow] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, KEPT_KEY));
  const kept = (keptRow?.value ?? {}) as Record<string, string>;
  const bySeries = new Map<string, typeof rows>();
  for (const r of rows) bySeries.set(r.seriesId!, [...(bySeries.get(r.seriesId!) ?? []), r]);
  const out: WorthALook[] = [];
  for (const [seriesId, list] of bySeries) {
    if (list.length < 4) continue;
    if (kept[seriesId] && new Date(kept[seriesId]) > now) continue;
    const last4 = list.slice(-4);
    const empty = last4.filter((r) => !r.hadNotes || (r.actions === 0 && r.decisions === 0)).length;
    if (empty < 3) continue;
    const perWeek = list.length / 8;
    const howOften = perWeek >= 0.9 ? "weekly" : perWeek >= 0.45 ? "every 2 weeks" : `about ${Math.round(perWeek * 4.3)} a month`;
    const minutes = list.reduce((n, r) => n + r.minutes, 0) / list.length;
    const latest = list[list.length - 1];
    out.push({
      seriesId,
      title: latest.title,
      howOften,
      hoursAMonth: round1((minutes * perWeek * 4.3) / 60),
      lastFour: { notes: last4.filter((r) => r.hadNotes).length, actions: last4.reduce((n, r) => n + r.actions, 0), decisions: last4.reduce((n, r) => n + r.decisions, 0) },
      organiser: latest.organiser,
      note: `Hi, I've been looking at how I spend my week. I wonder if we still need "${latest.title}" ${howOften === "weekly" ? "every week" : howOften}. Could we try it less often, or shorter, and see how it goes? Happy to keep it if it's useful to you.`,
    });
  }
  return out.sort((a, b) => b.hoursAMonth - a.hoursAMonth);
}

/** Keep: not asked about this series again for 12 weeks. */
export async function keepSeries(seriesId: string, now = new Date()): Promise<void> {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, KEPT_KEY));
  const kept = { ...((row?.value ?? {}) as Record<string, string>), [seriesId]: new Date(now.getTime() + 84 * DAY).toISOString() };
  await db.insert(appSettingsTable).values({ key: KEPT_KEY, value: kept }).onConflictDoUpdate({ target: appSettingsTable.key, set: { value: kept, updatedAt: new Date() } });
}

