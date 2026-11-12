/**
 * The stuck-task coach (build plan section 27). Once a day it finds Now and Backlog tasks that keep
 * slipping, worked out without AI:
 *
 * - the due date was moved two or more times;
 * - it was snoozed two or more times;
 * - it is five or more days overdue;
 * - it has sat in Now for seven or more days without a change.
 *
 * Up to ten at a time go to Haiku, which suggests one thing to try: a first step, splitting it,
 * handing it to the colleague the delegation suggester named, or dropping it. The task panel shows
 * the line with "Add as first step" and "Not stuck". Tasks hidden from AI are never sent.
 */
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { appSettingsTable, auditEventsTable, db, peopleTable, projectsTable, tasksTable, type StuckHint } from "@workspace/db";
import { addDays, todayLondon } from "@workspace/shared";
import { taskVisible } from "../lib/ai-data/visibility";
import { logger } from "../lib/logger";
import { adviseStuck, type StuckCandidate } from "./stuckJudge";
import { NotFoundError } from "./tasks";

const KEY = "stuck_coach_last";
const DAY = 86_400_000;
const PER_RUN = 10;
/** A task looked at is looked at again after this long, in case it slipped further. */
const RECHECK_DAYS = 7;
const MOVES = 2;
const OVERDUE_DAYS = 5;
const NOW_DAYS = 7;

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : one + "s"}`;

type Row = typeof tasksTable.$inferSelect;

/** Why each task looks stuck, or nothing when it does not. No AI. */
export async function stuckReasons(tasks: Row[], now = new Date()): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (!tasks.length) return out;
  const ids = tasks.map((t) => t.id);
  const moved = await db
    .select({
      id: auditEventsTable.entityId,
      due: sql<number>`count(*) filter (where ${auditEventsTable.payload}->'changes' @> '[{"field":"dueDate"}]'::jsonb)::int`,
      snoozed: sql<number>`count(*) filter (where ${auditEventsTable.action} = 'snooze')::int`,
    })
    .from(auditEventsTable)
    .where(and(eq(auditEventsTable.entityType, "task"), inArray(auditEventsTable.entityId, ids), inArray(auditEventsTable.action, ["update", "status", "snooze"]), eq(auditEventsTable.actor, "ollie")))
    .groupBy(auditEventsTable.entityId);
  const byId = new Map(moved.map((m) => [m.id, m]));
  const today = todayLondon(now);
  for (const t of tasks) {
    const why: string[] = [];
    const m = byId.get(t.id);
    if (m && m.due >= MOVES) why.push(`Due date moved ${plural(m.due, "time")}`);
    if (m && m.snoozed >= MOVES) why.push(`Snoozed ${plural(m.snoozed, "time")}`);
    if (t.dueDate && t.dueDate <= addDays(today, -OVERDUE_DAYS)) {
      const days = Math.round((Date.parse(today) - Date.parse(t.dueDate)) / DAY);
      why.push(`${plural(days, "day")} overdue`);
    }
    const idle = Math.floor((now.getTime() - t.updatedAt.getTime()) / DAY);
    if (t.status === "now" && idle >= NOW_DAYS) why.push(`In Now for ${plural(idle, "day")} without a change`);
    if (why.length) out.set(t.id, why.join(", ").replace(/^./, (c) => c.toUpperCase()));
  }
  return out;
}

export interface StuckResult {
  looked: number;
  stuck: number;
  failed: boolean;
}

export async function coachStuckTasks(now = new Date()): Promise<StuckResult> {
  const result: StuckResult = { looked: 0, stuck: 0, failed: false };
  const recheck = new Date(now.getTime() - RECHECK_DAYS * DAY);
  const tasks = await db
    .select()
    .from(tasksTable)
    .where(
      and(
        inArray(tasksTable.status, ["now", "backlog"]),
        isNull(tasksTable.stuckDismissedAt),
        or(isNull(tasksTable.stuckCheckedAt), sql`${tasksTable.stuckCheckedAt} < ${recheck.toISOString()}::timestamptz`),
        sql.raw(taskVisible("tasks")),
      ),
    )
    .orderBy(sql`${tasksTable.stuckCheckedAt} asc nulls first`, desc(tasksTable.updatedAt))
    .limit(300);
  const reasons = await stuckReasons(tasks, now);
  const clear = tasks.filter((t) => !reasons.has(t.id));
  // Marked as looked at without touching updatedAt, which the "In Now for N days" check reads.
  const mark = (ids: number[], hint: StuckHint | null | undefined) =>
    ids.length
      ? db
          .update(tasksTable)
          .set({ ...(hint !== undefined ? { stuckHint: hint } : {}), stuckCheckedAt: now, updatedAt: sql`${tasksTable.updatedAt}` })
          .where(inArray(tasksTable.id, ids))
      : Promise.resolve();
  await mark(clear.map((t) => t.id), null);
  result.looked += clear.length;

  const stuck = tasks.filter((t) => reasons.has(t.id)).slice(0, PER_RUN);
  if (!stuck.length) return result;
  const projIds = [...new Set(stuck.map((t) => t.projectId).filter((x): x is number => x != null))];
  const personIds = [...new Set(stuck.map((t) => t.personId).filter((x): x is number => x != null))];
  const [projects, people] = await Promise.all([
    projIds.length ? db.select({ id: projectsTable.id, name: projectsTable.name }).from(projectsTable).where(inArray(projectsTable.id, projIds)) : [],
    personIds.length ? db.select({ id: peopleTable.id, name: peopleTable.name }).from(peopleTable).where(inArray(peopleTable.id, personIds)) : [],
  ]);
  const proj = new Map(projects.map((p) => [p.id, p.name]));
  const person = new Map(people.map((p) => [p.id, p.name]));
  const asked: StuckCandidate[] = stuck.map((t, i) => ({
    n: i + 1,
    title: t.title,
    status: t.status === "now" ? "Now" : "Backlog",
    why: reasons.get(t.id)!,
    due: t.dueDate,
    project: t.projectId != null ? (proj.get(t.projectId) ?? null) : null,
    person: t.personId != null ? (person.get(t.personId) ?? null) : null,
    from: t.source,
    notes: t.notes ? t.notes.replace(/\s+/g, " ").slice(0, 400) : null,
    steps: t.steps.map((s) => `${s.done ? "done" : "to do"}: ${s.title}`).slice(0, 10),
    couldGoTo: t.delegateHint && !t.delegateDismissedAt ? t.delegateHint.personName : null,
  }));
  let advice;
  try {
    advice = new Map((await adviseStuck(asked, now)).map((a) => [a.n, a]));
  } catch (err) {
    logger.warn({ err }, "Stuck-task coach failed");
    result.failed = true;
    return result;
  }
  for (const [i, t] of stuck.entries()) {
    const a = advice.get(i + 1);
    if (!a) continue;
    // "Delegate" only stands when a colleague was named.
    const kind = a.kind === "delegate" && !asked[i].couldGoTo ? "first_step" : a.kind;
    const hint: StuckHint = { why: reasons.get(t.id)!, kind, suggestion: a.suggestion, step: kind === "first_step" || kind === "split" ? a.step || null : null };
    await mark([t.id], hint);
    result.looked++;
    result.stuck++;
  }
  return result;
}

/** Once a day, after the scheduled checks. */
export async function coachStuckIfDue(now = new Date()): Promise<StuckResult & { ran: boolean }> {
  const [last] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, KEY));
  const at = (last?.value as { at?: string } | undefined)?.at;
  if (at && now.getTime() - Date.parse(at) < DAY - 3_600_000) return { ran: false, looked: 0, stuck: 0, failed: false };
  const r = await coachStuckTasks(now);
  const value = { at: now.toISOString(), ...r };
  await db.insert(appSettingsTable).values({ key: KEY, value }).onConflictDoUpdate({ target: appSettingsTable.key, set: { value, updatedAt: new Date() } });
  return { ran: true, ...r };
}

/**
 * "Not stuck", or the suggestion was used (the step added, or the task dropped): the hint goes and
 * the task is not flagged again. Which it was is kept on the hint, for the coach's scorecard.
 */
export async function dismissStuckHint(taskId: number, used = false, now = new Date()): Promise<{ id: number }> {
  const [row] = await db
    .update(tasksTable)
    .set({
      stuckDismissedAt: now,
      stuckHint: sql`case when ${tasksTable.stuckHint} is null then null else ${tasksTable.stuckHint} || ${JSON.stringify({ outcome: used ? "used" : "not_stuck" })}::jsonb end`,
      updatedAt: sql`${tasksTable.updatedAt}`,
    })
    .where(eq(tasksTable.id, taskId))
    .returning({ id: tasksTable.id });
  if (!row) throw new NotFoundError("Task not found");
  return row;
}
