import { and, desc, eq, gte, inArray, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import {
  db,
  goalsTable,
  peopleTable,
  projectsTable,
  tasksTable,
  type InsertTask,
  type Task as TaskRow,
  type TaskStep,
} from "@workspace/db";
import {
  OPEN_STATUSES,
  PRIORITY_LABELS,
  STATUS_LABELS,
  addDays,
  buildRepeat,
  formatLong,
  formatTime,
  londonRange,
  parseQuickAdd,
  snoozeUntilTomorrow,
  todayLondon,
  repeatLabel,
  weekStartOf,
  type Priority,
  type RepeatEvery,
  type RepeatRule,
  type TaskSource,
  type TaskStatus,
  CHASE_AFTER_DAYS,
  DROP_REASON_LABELS,
  type DropReason,
} from "@workspace/shared";
import { writeAudit } from "../lib/audit";
import type { FieldChange } from "./history";
import { makeNextCopy, withdrawNextCopy } from "./repeats";
import { toTaskView, toTaskViews, type TaskView } from "./taskView";

export type TaskTab = "inbox" | "open" | "now" | "backlog" | "waiting" | "done" | "noise" | "dropped" | "archived";

export class NotFoundError extends Error {}
export class ValidationError extends Error {}
export class ConflictError extends Error {}
/** A service OllieOS depends on (the model) failed; nothing was saved. */
export class UpstreamError extends Error {}

/** The lifecycle fields a status change, triage, snooze or restore touches. Stored in the audit payload so undo can put them back. */
export interface LifecycleSnapshot {
  status: TaskStatus;
  waitingOnPersonId: number | null;
  waitingSince: string | null;
  triagedAt: string | null;
  completedAt: string | null;
  snoozedUntil: string | null;
  noiseRuleId: number | null;
}

export function snapshotOf(t: TaskRow): LifecycleSnapshot {
  return {
    status: t.status,
    waitingOnPersonId: t.waitingOnPersonId,
    waitingSince: t.waitingSince?.toISOString() ?? null,
    triagedAt: t.triagedAt?.toISOString() ?? null,
    completedAt: t.completedAt?.toISOString() ?? null,
    snoozedUntil: t.snoozedUntil?.toISOString() ?? null,
    noiseRuleId: t.noiseRuleId,
  };
}

const OPEN = [...OPEN_STATUSES] as TaskStatus[];

const priorityRank = sql`case ${tasksTable.priority} when 'high' then 0 when 'medium' then 1 else 2 end`;

function tabCondition(tab: TaskTab): SQL {
  if (tab === "open") return inArray(tasksTable.status, OPEN);
  return eq(tasksTable.status, tab);
}

export interface ListTasksParams {
  /** Section 27: "overdue", or one day (YYYY-MM-DD): only tasks due then */
  due?: string;
  tab?: TaskTab;
  source?: TaskSource;
  weekStart?: string;
  includeUndated?: boolean;
  q?: string;
}

export async function listTasks(params: ListTasksParams): Promise<TaskView[]> {
  const tab = params.tab ?? "open";
  const conditions: SQL[] = [tabCondition(tab)];

  if (params.source) conditions.push(eq(tasksTable.source, params.source));

  if (params.weekStart) {
    const ws = weekStartOf(params.weekStart);
    if (tab === "done") {
      const { start, end } = londonRange(ws, 7);
      conditions.push(gte(tasksTable.completedAt, start), lt(tasksTable.completedAt, end));
    } else {
      const inWeek = and(gte(tasksTable.dueDate, ws), lte(tasksTable.dueDate, addDays(ws, 6)))!;
      conditions.push(params.includeUndated ? or(inWeek, isNull(tasksTable.dueDate))! : inWeek);
    }
  }

  if (params.due === "overdue") conditions.push(lt(tasksTable.dueDate, todayLondon()));
  else if (params.due) conditions.push(eq(tasksTable.dueDate, params.due));

  const q = params.q?.trim();
  if (q) {
    conditions.push(
      or(
        sql`${tasksTable.search} @@ websearch_to_tsquery('english', ${q})`,
        sql`${tasksTable.title} ilike ${"%" + q.replace(/[%_\\]/g, "\\$&") + "%"}`,
      )!,
    );
  }

  const order =
    tab === "done"
      ? [desc(tasksTable.completedAt), desc(tasksTable.id)]
      : tab === "noise" || tab === "dropped" || tab === "archived"
        ? [desc(tasksTable.updatedAt), desc(tasksTable.id)]
        : tab === "inbox"
          ? [desc(tasksTable.capturedAt), desc(tasksTable.createdAt)]
          : [sql`${tasksTable.position} asc nulls last`, sql`${tasksTable.dueDate} asc nulls last`, priorityRank, desc(tasksTable.createdAt)];

  const rows = await db
    .select()
    .from(tasksTable)
    .where(and(...conditions))
    .orderBy(...order)
    .limit(500);

  return toTaskViews(rows);
}

/** The tabs whose list Ollie can put in his own order by dragging. */
export const REORDERABLE_TABS: TaskTab[] = ["open", "now", "backlog", "waiting"];

/**
 * Puts the given tasks in this order, as dragged in the task list.
 *
 * Positions are global, but a view only shows some tasks, so the listed tasks swap among the
 * positions they already hold. That keeps their order against tasks outside this view. Tasks
 * never placed by hand take fresh positions after every placed task, which is where they showed.
 * `clear` instead forgets the hand order for these tasks, so they go back to due-date order.
 * Neither counts as touching the task, so updatedAt (and the stale flag) is left alone.
 */
export async function reorderTasks(ids: number[], clear = false): Promise<void> {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const keepUpdatedAt = sql`${tasksTable.updatedAt}`;
  if (clear) {
    await db.update(tasksTable).set({ position: null, updatedAt: keepUpdatedAt }).where(inArray(tasksTable.id, unique));
    return;
  }
  await db.transaction(async (tx) => {
    // Serialise reorders so two never hand out the same fresh positions.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('tasks.reorder'))`);
    const rows = await tx
      .select({ id: tasksTable.id, position: tasksTable.position })
      .from(tasksTable)
      .where(inArray(tasksTable.id, unique));
    const found = new Set(rows.map((r) => r.id));
    const order = unique.filter((id) => found.has(id));
    if (!order.length) return;
    const slots = rows.map((r) => r.position).filter((p): p is number => p !== null).sort((a, b) => a - b);
    if (slots.length < order.length) {
      const [{ max }] = await tx.select({ max: sql<number | null>`max(${tasksTable.position})` }).from(tasksTable);
      let next = (max ?? 0) + 1;
      while (slots.length < order.length) slots.push(next++);
    }
    const cases = sql.join(order.map((id, i) => sql`when ${id} then ${slots[i]}::integer`), sql` `);
    await tx
      .update(tasksTable)
      .set({ position: sql`case ${tasksTable.id} ${cases} end`, updatedAt: keepUpdatedAt })
      .where(inArray(tasksTable.id, order));
  });
}

export async function getTaskSummary(weekStartParam?: string) {
  const ws = weekStartOf(weekStartParam ?? todayLondon());
  const { start, end } = londonRange(ws, 7);

  const [counts] = await db
    .select({
      inbox: sql<number>`count(*) filter (where ${tasksTable.status} = 'inbox')::int`,
      now: sql<number>`count(*) filter (where ${tasksTable.status} = 'now')::int`,
      backlog: sql<number>`count(*) filter (where ${tasksTable.status} = 'backlog')::int`,
      waiting: sql<number>`count(*) filter (where ${tasksTable.status} = 'waiting')::int`,
      done: sql<number>`count(*) filter (where ${tasksTable.status} = 'done')::int`,
      noise: sql<number>`count(*) filter (where ${tasksTable.status} = 'noise')::int`,
      dropped: sql<number>`count(*) filter (where ${tasksTable.status} = 'dropped')::int`,
      archived: sql<number>`count(*) filter (where ${tasksTable.status} = 'archived')::int`,
      dueThisWeek: sql<number>`count(*) filter (where ${tasksTable.status} in ('inbox','now','backlog','waiting') and ${tasksTable.dueDate} between ${ws} and ${addDays(ws, 6)})::int`,
      doneThisWeek: sql<number>`count(*) filter (where ${tasksTable.status} = 'done' and ${tasksTable.completedAt} >= ${start.toISOString()} and ${tasksTable.completedAt} < ${end.toISOString()})::int`,
    })
    .from(tasksTable);

  return {
    tabs: {
      inbox: counts.inbox,
      open: counts.inbox + counts.now + counts.backlog + counts.waiting,
      now: counts.now,
      backlog: counts.backlog,
      waiting: counts.waiting,
      done: counts.done,
      noise: counts.noise,
      dropped: counts.dropped,
      archived: counts.archived,
    },
    stats: {
      inboxToTriage: counts.inbox,
      dueThisWeek: counts.dueThisWeek,
      waitingOnOthers: counts.waiting,
      doneThisWeek: counts.doneThisWeek,
    },
    load: await taskLoad(),
  };
}

/** A day counts as overloaded from this many open tasks due, with at least OVERLOAD_NOT_NOW of them not in Now. */
const OVERLOAD_DUE = 4;
const OVERLOAD_NOT_NOW = 3;

/**
 * Section 27: where the coming week is too full. Overdue open tasks, the fullest day in the next
 * seven with most of its tasks not yet in Now, and Waiting on tasks ready for a chase.
 */
export async function taskLoad(now = new Date()) {
  const today = todayLondon(now);
  const rows = await db
    .select({ dueDate: tasksTable.dueDate, status: tasksTable.status, n: sql<number>`count(*)::int` })
    .from(tasksTable)
    .where(and(inArray(tasksTable.status, ["now", "backlog", "inbox"]), lte(tasksTable.dueDate, addDays(today, 6))))
    .groupBy(tasksTable.dueDate, tasksTable.status);
  let overdue = 0;
  const days = new Map<string, { due: number; inNow: number }>();
  for (const r of rows) {
    if (!r.dueDate) continue;
    if (r.dueDate < today) {
      overdue += r.n;
      continue;
    }
    const d = days.get(r.dueDate) ?? { due: 0, inNow: 0 };
    d.due += r.n;
    if (r.status === "now") d.inNow += r.n;
    days.set(r.dueDate, d);
  }
  const busiest = [...days.entries()]
    .filter(([, d]) => d.due >= OVERLOAD_DUE && d.due - d.inNow >= OVERLOAD_NOT_NOW)
    .sort((a, b) => b[1].due - a[1].due || (a[0] < b[0] ? -1 : 1))[0];
  const [{ toChase }] = await db
    .select({ toChase: sql<number>`count(*)::int` })
    .from(tasksTable)
    .where(and(eq(tasksTable.status, "waiting"), chaseDueSql(now)));
  return { overdue, busiest: busiest ? { date: busiest[0], due: busiest[1].due, inNow: busiest[1].inNow } : null, toChase };
}

/** True for a Waiting on task that has waited long enough for a chase. */
export const chaseDueSql = (now = new Date()): SQL =>
  sql`coalesce(${tasksTable.chaseAfter}, coalesce(${tasksTable.waitingSince}, ${tasksTable.createdAt}) + make_interval(days => ${CHASE_AFTER_DAYS})) <= ${now.toISOString()}::timestamptz`;

/** "Not yet" on a chase nudge, or after a chase was sent: leave it alone for another few days. */
export async function chaseLater(id: number, now = new Date()): Promise<TaskView> {
  await loadTask(id);
  const [row] = await db
    .update(tasksTable)
    .set({ chaseAfter: new Date(now.getTime() + CHASE_AFTER_DAYS * 86_400_000), updatedAt: sql`${tasksTable.updatedAt}` })
    .where(eq(tasksTable.id, id))
    .returning();
  return toTaskView(row);
}

export interface BulkUpdateInput {
  status?: TaskStatus;
  priority?: Priority;
  dueDate?: string | null;
  projectId?: number | null;
  dropReason?: DropReason | null;
}

/** Section 27: the same change to several tasks at once. Each goes through updateTask, so history and undo work as for one. */
export async function bulkUpdate(ids: number[], input: BulkUpdateInput, actor: string): Promise<{ updated: number; failed: number }> {
  let updated = 0;
  let failed = 0;
  for (const id of [...new Set(ids)]) {
    try {
      await updateTask(id, input, actor);
      updated++;
    } catch (err) {
      if (!(err instanceof NotFoundError) && !(err instanceof ValidationError)) throw err;
      failed++;
    }
  }
  return { updated, failed };
}

export async function loadTask(id: number): Promise<TaskRow> {
  const [row] = await db.select().from(tasksTable).where(eq(tasksTable.id, id));
  if (!row) throw new NotFoundError("Task not found");
  return row;
}

export async function getTask(id: number): Promise<TaskView> {
  return toTaskView(await loadTask(id));
}

export interface TaskUpdateInput {
  title?: string;
  kind?: "task" | "promise";
  status?: TaskStatus;
  priority?: Priority;
  dueDate?: string | null;
  notes?: string | null;
  projectId?: number | null;
  personId?: number | null;
  waitingOnPersonId?: number | null;
  confidential?: boolean | null;
  /** A direct goal link; overrides the project's goal */
  goalId?: number | null;
  /** "Not goal work": the Goals page stops asking about it */
  notGoalWork?: boolean;
  /** Repeat it, anchored on its due date (today when it has none); null stops repeating */
  repeat?: { every: RepeatEvery; byWeekday?: boolean } | null;
  /** The whole checklist, in order */
  steps?: TaskStep[];
  /** Section 27: why it was dropped or sent to Noise; null clears it */
  dropReason?: DropReason | null;
}

export const MAX_STEPS = 50;

/** Tidies a checklist from a client: trims titles, drops empty ones, and makes sure ids are unique. */
export function cleanSteps(steps: TaskStep[]): TaskStep[] {
  const seen = new Set<string>();
  const out: TaskStep[] = [];
  for (const s of steps) {
    const title = s.title.trim().slice(0, 300);
    if (!title) continue;
    let id = s.id.trim().slice(0, 40) || Math.random().toString(36).slice(2, 10);
    while (seen.has(id)) id = Math.random().toString(36).slice(2, 10);
    seen.add(id);
    out.push({ id, title, done: !!s.done });
  }
  if (out.length > MAX_STEPS) throw new ValidationError(`A task can have up to ${MAX_STEPS} steps`);
  return out;
}

export function stepsSummary(steps: TaskStep[]): string {
  return `${steps.filter((s) => s.done).length} of ${steps.length} done`;
}

export async function personName(id: number | null): Promise<string | null> {
  if (!id) return null;
  const [p] = await db.select({ name: peopleTable.name }).from(peopleTable).where(eq(peopleTable.id, id));
  if (!p) throw new ValidationError("That person does not exist");
  return p.name;
}

async function goalName(id: number | null): Promise<string | null> {
  if (!id) return null;
  const [g] = await db.select({ name: goalsTable.name }).from(goalsTable).where(eq(goalsTable.id, id));
  if (!g) throw new ValidationError("That goal does not exist");
  return g.name;
}

async function projectName(id: number | null): Promise<string | null> {
  if (!id) return null;
  const [p] = await db.select({ name: projectsTable.name }).from(projectsTable).where(eq(projectsTable.id, id));
  if (!p) throw new ValidationError("That project does not exist");
  return p.name;
}

/** Applies an edit, keeps the lifecycle timestamps right, and records each change in the audit trail. */
export async function updateTask(id: number, input: TaskUpdateInput, actor: string, clientId: number | null = null): Promise<TaskView> {
  const current = await loadTask(id);
  const set: Partial<InsertTask> = {};
  const changes: FieldChange[] = [];
  const now = new Date();

  if (input.title !== undefined && input.title.trim() !== current.title) {
    const title = input.title.trim();
    if (!title) throw new ValidationError("A task needs a title");
    set.title = title;
    changes.push({ field: "title", from: current.title, to: title });
  }
  if (input.kind !== undefined && input.kind !== current.kind) {
    set.kind = input.kind;
    changes.push({ field: "kind", from: current.kind === "promise" ? "Promise" : "Task", to: input.kind === "promise" ? "Promise" : "Task" });
  }
  if (input.priority !== undefined && input.priority !== current.priority) {
    set.priority = input.priority;
    changes.push({ field: "priority", from: PRIORITY_LABELS[current.priority], to: PRIORITY_LABELS[input.priority] });
  }
  if (input.dueDate !== undefined && input.dueDate !== current.dueDate) {
    set.dueDate = input.dueDate;
    changes.push({
      field: "dueDate",
      from: current.dueDate ? formatLong(current.dueDate) : null,
      to: input.dueDate ? formatLong(input.dueDate) : null,
    });
  }
  if (input.notes !== undefined && (input.notes ?? "") !== (current.notes ?? "")) {
    set.notes = input.notes?.trim() ? input.notes : null;
    changes.push({ field: "notes", from: null, to: set.notes ? "edited" : null });
  }
  if (input.projectId !== undefined && input.projectId !== current.projectId) {
    set.projectId = input.projectId;
    changes.push({ field: "project", from: await projectName(current.projectId), to: await projectName(input.projectId) });
  }
  if (input.personId !== undefined && input.personId !== current.personId) {
    set.personId = input.personId;
    changes.push({ field: "person", from: await personName(current.personId), to: await personName(input.personId) });
  }
  if (input.waitingOnPersonId !== undefined && input.waitingOnPersonId !== current.waitingOnPersonId) {
    set.waitingOnPersonId = input.waitingOnPersonId;
    changes.push({
      field: "waitingOn",
      from: await personName(current.waitingOnPersonId),
      to: await personName(input.waitingOnPersonId),
    });
  }
  if (input.confidential !== undefined && input.confidential !== current.confidential) {
    set.confidential = input.confidential;
    changes.push({
      field: "confidential",
      from: current.confidential === null ? null : current.confidential ? "Yes" : "No",
      to: input.confidential === null ? null : input.confidential ? "Yes" : "No",
    });
  }

  // Linking a goal answers the Goals page's question, so "Not goal work" and a goal never both stand.
  if (input.goalId !== undefined && input.goalId !== current.goalId) {
    set.goalId = input.goalId;
    if (input.goalId != null && current.notGoalWork) set.notGoalWork = false;
    changes.push({ field: "goal", from: await goalName(current.goalId), to: await goalName(input.goalId) });
  }
  if (input.notGoalWork !== undefined && input.notGoalWork !== current.notGoalWork) {
    set.notGoalWork = input.notGoalWork;
    if (input.notGoalWork && (set.goalId ?? current.goalId) != null) set.goalId = null;
    changes.push({ field: "notGoalWork", from: current.notGoalWork ? "Yes" : "No", to: input.notGoalWork ? "Yes" : "No" });
  }

  // Repeats are anchored on the due date, so moving the date moves the anchor with it.
  const dueAfter = set.dueDate !== undefined ? set.dueDate : current.dueDate;
  let ruleAfter: RepeatRule | null = (current.repeat as RepeatRule | null) ?? null;
  if (input.repeat !== undefined) {
    if (input.repeat === null) ruleAfter = null;
    else {
      const anchor = dueAfter ?? todayLondon(now);
      if (!dueAfter) {
        set.dueDate = anchor;
        changes.push({ field: "dueDate", from: null, to: formatLong(anchor) });
      }
      ruleAfter = buildRepeat(input.repeat.every, anchor, !!input.repeat.byWeekday);
    }
  } else if (ruleAfter && set.dueDate) {
    ruleAfter = buildRepeat(ruleAfter.every, set.dueDate, ruleAfter.nth != null);
  }
  if (JSON.stringify(ruleAfter) !== JSON.stringify(current.repeat ?? null)) {
    set.repeat = ruleAfter;
    const from = current.repeat ? repeatLabel(current.repeat as RepeatRule) : null;
    const to = ruleAfter ? repeatLabel(ruleAfter) : null;
    if (from !== to) changes.push({ field: "repeat", from, to });
  }

  if (input.steps !== undefined) {
    const steps = cleanSteps(input.steps);
    if (JSON.stringify(steps) !== JSON.stringify(current.steps ?? [])) {
      set.steps = steps;
      changes.push({ field: "steps", from: null, to: steps.length ? stepsSummary(steps) : null });
    }
  }

  let statusChanged = false;
  if (input.status !== undefined && input.status !== current.status) {
    statusChanged = true;
    const to = input.status;
    set.status = to;
    changes.unshift({ field: "status", from: STATUS_LABELS[current.status], to: STATUS_LABELS[to] });

    if (to === "done") set.completedAt = now;
    else if (current.status === "done") set.completedAt = null;

    if (current.status === "inbox" && !current.triagedAt) set.triagedAt = now;

    if (to === "waiting") set.waitingSince = now;
    else if (current.status === "waiting") set.waitingSince = null;

    if (to === "done" || to === "noise" || to === "dropped" || to === "archived") set.snoozedUntil = null;
  }

  // Section 27: why it was dropped. Going back to an open status forgets the reason.
  const leavesClosed = statusChanged && set.status !== "dropped" && set.status !== "noise";
  const reason = input.dropReason !== undefined ? input.dropReason : leavesClosed ? null : undefined;
  if (reason !== undefined && reason !== current.dropReason) {
    set.dropReason = reason;
    const label = (r: string | null) => (r ? (DROP_REASON_LABELS[r as DropReason] ?? r) : null);
    if (input.dropReason !== undefined) changes.push({ field: "dropReason", from: label(current.dropReason), to: label(reason) });
  }
  // A task that starts waiting again is given the usual time before a chase.
  if (statusChanged && set.status === "waiting") set.chaseAfter = null;

  if (changes.length === 0 && Object.keys(set).length === 0) return toTaskView(current);
  if (changes.length === 0) {
    const [row] = await db.update(tasksTable).set(set).where(eq(tasksTable.id, id)).returning();
    return toTaskView(row);
  }

  const updated = await db.transaction(async (tx) => {
    if (statusChanged && set.status === "done" && ruleAfter && !current.repeatNextId) {
      set.repeatNextId = await makeNextCopy(tx, { ...current, ...set } as TaskRow, ruleAfter, actor, clientId, now);
    } else if (statusChanged && current.status === "done" && current.repeatNextId) {
      if (await withdrawNextCopy(tx, current.repeatNextId, actor)) set.repeatNextId = null;
    }
    const [row] = await tx.update(tasksTable).set(set).where(eq(tasksTable.id, id)).returning();
    await writeAudit(tx, {
      actor,
      clientId,
      action: statusChanged ? "status" : "update",
      entityType: "task",
      entityId: id,
      payload: statusChanged ? { changes, previous: snapshotOf(current) } : { changes },
    });
    return row;
  });

  return toTaskView(updated);
}

/**
 * Dropping or archiving a repeating task stops the repeats. "Keep repeating" makes the next copy
 * anyway, as if it had been ticked off.
 */
export async function continueRepeat(id: number, actor: string): Promise<TaskView> {
  const current = await loadTask(id);
  if (!current.repeat) throw new ConflictError("This task does not repeat");
  if (current.repeatNextId) throw new ConflictError("The next one has already been made");
  const updated = await db.transaction(async (tx) => {
    const nextId = await makeNextCopy(tx, current, current.repeat!, actor, null);
    const [row] = await tx.update(tasksTable).set({ repeatNextId: nextId }).where(eq(tasksTable.id, id)).returning();
    return row;
  });
  return toTaskView(updated);
}

/** "Keep" in the Backlog clear-out: still wanted, so the 30-day clock starts again. */
export async function keepInBacklog(id: number, actor: string): Promise<TaskView> {
  const current = await loadTask(id);
  if (current.status !== "backlog") throw new ConflictError("Only Backlog tasks can be kept this way");
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(tasksTable).set({ updatedAt: new Date() }).where(eq(tasksTable.id, id)).returning();
    await writeAudit(tx, { actor, action: "keep_backlog", entityType: "task", entityId: id, payload: {} });
    return row;
  });
  return toTaskView(updated);
}

export async function snoozeTask(id: number, actor: string): Promise<TaskView> {
  const current = await loadTask(id);
  const until = snoozeUntilTomorrow();
  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(tasksTable).set({ snoozedUntil: until }).where(eq(tasksTable.id, id)).returning();
    await writeAudit(tx, {
      actor,
      action: "snooze",
      entityType: "task",
      entityId: id,
      payload: {
        until: until.toISOString(),
        untilLabel: `${formatLong(until)} at ${formatTime(until)}`,
        previous: snapshotOf(current),
      },
    });
    return row;
  });
  return toTaskView(updated);
}

export async function quickAddTask(text: string, actor: string): Promise<{ task: TaskView; warnings: string[] }> {
  const parsed = parseQuickAdd(text);
  if (!parsed.title) throw new ValidationError("Add a title for the task");

  const warnings = [...parsed.warnings];
  let projectId: number | null = null;
  if (parsed.projectSlug) {
    const [project] = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(eq(projectsTable.slug, parsed.projectSlug.toLowerCase()));
    if (project) projectId = project.id;
    else warnings.push(`No project called @${parsed.projectSlug}, added without a project`);
  }

  const row = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(tasksTable)
      .values({
        title: parsed.title,
        status: parsed.status,
        priority: parsed.priority,
        dueDate: parsed.dueDate,
        projectId,
        source: "manual",
        fromName: "Ollie",
        triagedAt: new Date(),
        createdBy: actor,
      })
      .returning();
    await writeAudit(tx, {
      actor,
      action: "create",
      entityType: "task",
      entityId: created.id,
      payload: { via: "quick_add", text },
    });
    return created;
  });

  return { task: await toTaskView(row), warnings };
}

export async function buildDraftPrompt(id: number): Promise<string> {
  const t = await getTask(id);
  const lines: string[] = [
    "Using OllieOS as the source of truth, draft what I need to send for this task. Do not send anything.",
    "",
    `Task: ${t.title}`,
  ];
  if (t.person) lines.push(`For: ${t.person.name}`);
  if (t.project) lines.push(`Project: ${t.project.name}`);
  if (t.waitingOn) lines.push(`Waiting on: ${t.waitingOn.name}`);
  if (t.dueDate) lines.push(`Due: ${formatLong(t.dueDate)}`);
  const from = [t.fromName, t.fromAddress ? `<${t.fromAddress}>` : null].filter(Boolean).join(" ");
  if (t.source !== "manual" || from) {
    lines.push(`Source: ${t.source}${from ? ` from ${from}` : ""}${t.sourceSubject ? `, "${t.sourceSubject}"` : ""}`);
  }
  if (t.sourceQuote) lines.push(`Quoted line: "${t.sourceQuote}"`);
  if (t.sourceUrl) lines.push(`Link: ${t.sourceUrl}`);
  if (t.notes) lines.push(`My notes: ${t.notes}`);
  lines.push("");
  const lookups = [t.person?.name, t.project?.name, t.waitingOn?.name].filter(Boolean);
  if (lookups.length) {
    lines.push(`Before drafting, use the OllieOS get_context tool on ${lookups.join(" and ")} to check facts, decisions and recent activity.`);
  }
  lines.push("Write in British English, keep it short and direct, and do not use em dashes.");
  return lines.join("\n");
}
