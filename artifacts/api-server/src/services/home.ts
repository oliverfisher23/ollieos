import { and, asc, desc, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { calendarEventsTable, db, peopleTable, projectsTable, sweepRunsTable, tasksTable } from "@workspace/db";
import {
  OPEN_STATUSES,
  daysBetween,
  formatLong,
  londonDate,
  londonRange,
  todayLondon,
  weekStartOf,
  type TaskSource,
  type TaskStatus,
} from "@workspace/shared";
import { toTaskViews, type TaskView } from "./taskView";
import { listAccessRequests } from "./access";
import { ensureSelfPerson, inboxCounts } from "./knowledgeInbox";
import { ensureSeeds } from "./seeds";

const OPEN = [...OPEN_STATUSES] as TaskStatus[];

function dayCount(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

/** Why a task is in the Do next queue, in plain words. */
function reasonFor(t: TaskView, today: string): string {
  const lead = t.kind === "promise" ? (t.person ? `You promised ${t.person.name}` : "A promise you made") : null;
  if (t.dueDate) {
    const diff = daysBetween(today, t.dueDate);
    let due: string;
    if (diff < 0) due = `Overdue by ${dayCount(-diff)}`;
    else if (diff === 0) due = "Due today";
    else if (diff === 1) due = "Due tomorrow";
    else due = `Due ${formatLong(t.dueDate)}`;
    if (lead) return `${lead}. ${due}`;
    return t.priority === "high" && diff >= 0 ? `High priority. ${due}` : due;
  }
  if (lead) return `${lead}. No due date`;
  return t.priority === "high" ? "High priority, no due date" : "Medium priority, no due date";
}

/**
 * Do next ranking: open Now tasks and open promises that are not snoozed.
 * Overdue first (oldest first), then High by due date, then Medium by due date,
 * undated last within each band. Low only appears when overdue. Ties go to the goal-linked task.
 */
function rankDoNext(tasks: TaskView[], today: string) {
  const band = (t: TaskView): number => {
    if (t.dueDate && t.dueDate < today) return 0;
    if (t.priority === "high") return 1;
    if (t.priority === "medium") return 2;
    return 3;
  };
  return tasks
    .filter((t) => band(t) < 3)
    .sort((a, b) => {
      const ba = band(a);
      const bb = band(b);
      if (ba !== bb) return ba - bb;
      if (a.dueDate && b.dueDate && a.dueDate !== b.dueDate) return a.dueDate < b.dueDate ? -1 : 1;
      if (a.dueDate && !b.dueDate) return -1;
      if (!a.dueDate && b.dueDate) return 1;
      // Same band and due date: goal-linked work first (feature 04 rule 5).
      if (!!a.goal !== !!b.goal) return a.goal ? -1 : 1;
      return a.createdAt.getTime() - b.createdAt.getTime();
    })
    .map((task) => ({ task, reason: reasonFor(task, today) }));
}

export interface CalendarBrief {
  type: "project" | "person";
  slug: string;
  name: string;
}

/** Brief me: each event's project, or its first linked person when there is no project. */
async function briefsFor(events: { id: number; projectId: number | null; personIds: number[] }[]): Promise<Map<number, CalendarBrief>> {
  const projectIds = [...new Set(events.map((e) => e.projectId).filter((x): x is number => x != null))];
  const personIds = [...new Set(events.flatMap((e) => e.personIds.slice(0, 1)))];
  const [projects, people] = await Promise.all([
    projectIds.length
      ? db.select({ id: projectsTable.id, slug: projectsTable.slug, name: projectsTable.name }).from(projectsTable).where(inArray(projectsTable.id, projectIds))
      : [],
    personIds.length
      ? db.select({ id: peopleTable.id, slug: peopleTable.slug, name: peopleTable.name }).from(peopleTable).where(inArray(peopleTable.id, personIds))
      : [],
  ]);
  const p = new Map(projects.map((r) => [r.id, r]));
  const pe = new Map(people.map((r) => [r.id, r]));
  const out = new Map<number, CalendarBrief>();
  for (const e of events) {
    const proj = e.projectId != null ? p.get(e.projectId) : undefined;
    const person = e.personIds.length ? pe.get(e.personIds[0]) : undefined;
    if (proj) out.set(e.id, { type: "project", slug: proj.slug, name: proj.name });
    else if (person) out.set(e.id, { type: "person", slug: person.slug, name: person.name });
  }
  return out;
}

export async function getHome() {
  const now = new Date();
  const today = todayLondon(now);
  const week = londonRange(weekStartOf(today), 7);
  const day = londonRange(today, 1);

  const [candidateRows, inboxBySource, waitingRows, promiseRows, doneCount, doneRows, lastSweep, todayEvents] =
    await Promise.all([
      db
        .select()
        .from(tasksTable)
        .where(
          and(
            sql`(${tasksTable.status} = 'now' or (${tasksTable.kind} = 'promise' and ${tasksTable.status} in ('inbox','now','backlog')))`,
            sql`(${tasksTable.snoozedUntil} is null or ${tasksTable.snoozedUntil} <= ${now.toISOString()})`,
          ),
        ),
      db
        .select({ source: tasksTable.source, count: sql<number>`count(*)::int` })
        .from(tasksTable)
        .where(eq(tasksTable.status, "inbox"))
        .groupBy(tasksTable.source),
      db.select().from(tasksTable).where(eq(tasksTable.status, "waiting")),
      db
        .select()
        .from(tasksTable)
        .where(and(eq(tasksTable.kind, "promise"), inArray(tasksTable.status, OPEN)))
        .orderBy(sql`${tasksTable.dueDate} asc nulls last`, asc(tasksTable.createdAt)),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(tasksTable)
        .where(and(eq(tasksTable.status, "done"), gte(tasksTable.completedAt, week.start), lt(tasksTable.completedAt, week.end))),
      db
        .select()
        .from(tasksTable)
        .where(and(eq(tasksTable.status, "done"), gte(tasksTable.completedAt, week.start), lt(tasksTable.completedAt, week.end)))
        .orderBy(desc(tasksTable.completedAt))
        .limit(5),
      db
        .select({ finishedAt: sweepRunsTable.finishedAt })
        .from(sweepRunsTable)
        .where(isNotNull(sweepRunsTable.finishedAt))
        .orderBy(desc(sweepRunsTable.finishedAt))
        .limit(1),
      db
        .select()
        .from(calendarEventsTable)
        .where(and(gte(calendarEventsTable.startsAt, day.start), lt(calendarEventsTable.startsAt, day.end)))
        .orderBy(asc(calendarEventsTable.startsAt)),
    ]);

  const briefs = await briefsFor(todayEvents);
  await ensureSelfPerson().catch(() => undefined);
  await ensureSeeds();
  const [candidates, waiting, promises, latestDone, access, knowledgeInbox] = await Promise.all([
    toTaskViews(candidateRows),
    toTaskViews(waitingRows),
    toTaskViews(promiseRows),
    toTaskViews(doneRows),
    listAccessRequests(),
    inboxCounts(),
  ]);

  const waitingOn = waiting
    .map((task) => ({
      task,
      daysWaiting: Math.max(0, daysBetween(londonDate(task.waitingSince ?? task.updatedAt), today)),
    }))
    .sort((a, b) => b.daysWaiting - a.daysWaiting);

  const bySource = inboxBySource
    .map((r) => ({ source: r.source as TaskSource, count: r.count }))
    .sort((a, b) => b.count - a.count);

  return {
    doNext: rankDoNext(candidates, today),
    inbox: { count: bySource.reduce((n, r) => n + r.count, 0), bySource },
    waitingOn,
    promises,
    doneThisWeek: { count: doneCount[0]?.count ?? 0, latest: latestDone },
    lastSweepAt: lastSweep[0]?.finishedAt ?? null,
    today: todayEvents.map((e) => ({
      id: e.id,
      title: e.title,
      startsAt: e.startsAt,
      endsAt: e.endsAt,
      personal: e.personal,
      location: e.location,
      brief: briefs.get(e.id) ?? null,
    })),
    access: { pending: access.pending, open: access.open },
    knowledgeInbox,
  };
}
