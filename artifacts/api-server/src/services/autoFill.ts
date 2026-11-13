/**
 * Filled in for you (build plan section 30, Part H). After three days of real use, 29 of 33 open tasks
 * had no project and none of the 27 dropped items had a reason: suggestions offered as chips mostly
 * went unpressed. So where there is one clear answer, OllieOS now sets it and says so:
 *
 * - **Project:** the one project the task clearly belongs to (`strongProjectFor`).
 * - **Due date:** the date the reader worked out from the message, while it is still today or ahead.
 * - **Person and Waiting on:** already linked by `linkPeopleToTasks` when one person fits; now marked.
 * - **Why it was dropped:** the likeliest reason, saved when the "Why?" chips are shown, so it is
 *   never recorded for a drop Ollie was not shown.
 *
 * Each shows "Set by OllieOS" with Undo. Undo clears the value and it is never filled on that task
 * again; changing the field himself makes it Ollie's. With two or more candidates nothing is set and
 * the chips stay. No AI is used, and filling in does not count as touching the task.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db, taskEvidenceTable, tasksTable, type AutoField, type AutoSet } from "@workspace/db";
import { DROP_REASONS, todayLondon, type DropReason } from "@workspace/shared";
import { writeAudit } from "../lib/audit";
import { closeOpenTasks, isStrongMatch } from "./duplicates";
import { waitingOnInTitle } from "./personNames";
import { strongProjectFor } from "./projectSuggest";
import { AUTO_ACTOR, NotFoundError, ValidationError, loadTask, updateTask } from "./tasks";
import { toTaskView, type TaskView } from "./taskView";

const OPEN = ["inbox", "now", "backlog", "waiting"] as const;
/** Projects are looked for on tasks this recent, and again a day later, because a thread's other tasks may get a project meanwhile. */
const PROJECT_WINDOW_DAYS = 30;
const RECHECK_MS = 24 * 3_600_000;
const BATCH = 60;

export const AUTO_FIELDS: AutoField[] = ["project", "due", "person", "waitingOn", "dropReason"];

/** Records that OllieOS set a field, leaving `updatedAt` as it was: Ollie has not touched the task. */
async function mark(taskId: number, field: AutoField, state: "set" | "undone", keepUpdatedAt: Date | null) {
  await db
    .update(tasksTable)
    .set({
      autoSet: sql`${tasksTable.autoSet} || ${JSON.stringify({ [field]: state })}::jsonb`,
      ...(keepUpdatedAt ? { updatedAt: keepUpdatedAt } : {}),
    })
    .where(eq(tasksTable.id, taskId));
}

export interface FillCounts {
  due: number;
  projects: number;
  looked: number;
}

/** Runs with the scheduled checks, after people are linked. */
export async function fillTasks(now = new Date()): Promise<FillCounts> {
  const today = todayLondon(now);
  const out: FillCounts = { due: 0, projects: 0, looked: 0 };

  // Due dates: the reader's own date for the message, never one already in the past.
  const dueRows = await db
    .select({ id: tasksTable.id, suggestedDue: tasksTable.suggestedDue, updatedAt: tasksTable.updatedAt })
    .from(tasksTable)
    .where(
      and(
        inArray(tasksTable.status, [...OPEN]),
        isNull(tasksTable.dueDate),
        isNotNull(tasksTable.suggestedDue),
        gte(tasksTable.suggestedDue, today),
        sql`not (${tasksTable.autoSet} ? 'due')`,
      ),
    )
    .orderBy(asc(tasksTable.id))
    .limit(BATCH);
  for (const r of dueRows) {
    await updateTask(r.id, { dueDate: r.suggestedDue }, AUTO_ACTOR);
    await mark(r.id, "due", "set", r.updatedAt);
    out.due++;
  }

  // Projects: recent open tasks with none, not looked at in the last day.
  const since = new Date(now.getTime() - PROJECT_WINDOW_DAYS * 86_400_000);
  const projectRows = await db
    .select({ id: tasksTable.id, updatedAt: tasksTable.updatedAt })
    .from(tasksTable)
    .where(
      and(
        inArray(tasksTable.status, [...OPEN]),
        isNull(tasksTable.projectId),
        gte(tasksTable.createdAt, since),
        sql`not (${tasksTable.autoSet} ? 'project')`,
        or(isNull(tasksTable.autoCheckedAt), lt(tasksTable.autoCheckedAt, new Date(now.getTime() - RECHECK_MS))),
      ),
    )
    .orderBy(sql`${tasksTable.autoCheckedAt} asc nulls first`, desc(tasksTable.id))
    .limit(BATCH);
  for (const r of projectRows) {
    out.looked++;
    const project = await strongProjectFor(r.id);
    if (project) {
      await updateTask(r.id, { projectId: project.id }, AUTO_ACTOR);
      await mark(r.id, "project", "set", null);
      out.projects++;
    }
    await db.update(tasksTable).set({ autoCheckedAt: now, updatedAt: r.updatedAt }).where(eq(tasksTable.id, r.id));
  }
  return out;
}

/** Undo on "Set by OllieOS": clears the value, and that field is never filled on this task again. */
export async function undoAuto(taskId: number, field: AutoField, actor: string): Promise<TaskView> {
  const t = await loadTask(taskId);
  if (t.autoSet[field] !== "set") throw new ValidationError("OllieOS did not set that, so there is nothing to undo");
  const clear =
    field === "project" ? { projectId: null } : field === "due" ? { dueDate: null } : field === "person" ? { personId: null } : field === "waitingOn" ? { waitingOnPersonId: null } : { dropReason: null };
  await updateTask(taskId, clear, actor);
  await mark(taskId, field, "undone", null);
  await writeAudit(db, { actor, action: "auto_undo", entityType: "task", entityId: taskId, payload: { field } });
  return toTaskView(await loadTask(taskId));
}

/* ---------- Why it was dropped ---------- */

const ARRANGING = /\b(book|schedule|reschedule|arrange|set up|find|diary|calendar|invite)\b.*\b(call|meeting|time|slot|catch[- ]?up|session|chat|1:1|121)\b|\b(what time|when are you free|are you free|availability)\b/i;
const FYI = /^(fyi|for (your )?info(rmation)?|note|heads[- ]up|read|see|be aware)\b|\b(no action|for info|fyi)\b/i;

/**
 * The likeliest reason, or null when nothing points one way. In order: the task was already shown as
 * done by a later message; an open task has nearly the same title; it is about fixing a time to meet;
 * it reads as for information; its title says someone else is to do it; and, failing those, the
 * reason Ollie most often gave for items from the same sender.
 */
export async function guessDropReason(taskId: number): Promise<DropReason | null> {
  const t = await loadTask(taskId);
  const [done] = await db
    .select({ id: taskEvidenceTable.id })
    .from(taskEvidenceTable)
    .where(and(eq(taskEvidenceTable.taskId, taskId), eq(taskEvidenceTable.shows, "done")))
    .limit(1);
  if (done) return "already_done";

  const close = await closeOpenTasks(t.title, 4);
  if (close.some((c) => c.id !== t.id && isStrongMatch(c.match))) return "duplicate";

  const words = [t.title, t.sourceSubject ?? ""].join(" ");
  if (ARRANGING.test(words)) return "arranging";
  if (FYI.test(t.title.trim())) return "fyi";
  // "Konrad to map the codes" in the Inbox is someone else's job, unless Ollie is waiting on it.
  if (t.status !== "waiting" && waitingOnInTitle(t.title)) return "not_mine";

  const from = t.fromAddress ? eq(tasksTable.fromAddress, t.fromAddress) : t.fromName && !/^(you|ollie)$/i.test(t.fromName.trim()) ? eq(tasksTable.fromName, t.fromName) : null;
  if (from) {
    const rows = await db
      .select({ reason: tasksTable.dropReason, n: sql<number>`count(*)::int` })
      .from(tasksTable)
      .where(and(from, ne(tasksTable.id, taskId), isNotNull(tasksTable.dropReason), sql`not (${tasksTable.autoSet} ? 'dropReason')`, eq(tasksTable.source, t.source)))
      .groupBy(tasksTable.dropReason)
      .orderBy(sql`count(*) desc`)
      .limit(2);
    // Only reasons Ollie chose himself count, and only when one is clearly his habit for this sender.
    const [top, next] = rows;
    if (top && top.n >= 2 && (!next || top.n >= next.n * 2) && (DROP_REASONS as readonly string[]).includes(top.reason ?? "")) return top.reason as DropReason;
  }
  return null;
}

/**
 * Called when the "Why?" chips are shown for a dropped item with no reason yet: saves the guess, marked
 * as OllieOS's, and returns it so the chip shows chosen. Returns null, saving nothing, when there is no
 * clear guess, the item is not dropped, or Ollie has undone a guess on it before.
 */
export async function saveDropReasonGuess(taskId: number): Promise<{ reason: DropReason | null; task: TaskView }> {
  const t = await loadTask(taskId);
  if (!t) throw new NotFoundError("That task does not exist");
  if ((t.status !== "dropped" && t.status !== "noise") || t.dropReason || t.autoSet.dropReason) return { reason: null, task: await toTaskView(t) };
  const reason = await guessDropReason(taskId);
  if (!reason) return { reason: null, task: await toTaskView(t) };
  await updateTask(taskId, { dropReason: reason }, AUTO_ACTOR);
  await mark(taskId, "dropReason", "set", t.updatedAt);
  return { reason, task: await toTaskView(await loadTask(taskId)) };
}

export type { AutoSet };
