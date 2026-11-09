import { and, desc, eq, gte, inArray, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm";
import {
  db,
  peopleTable,
  projectsTable,
  tasksTable,
  type InsertTask,
  type Task as TaskRow,
} from "@workspace/db";
import {
  OPEN_STATUSES,
  PRIORITY_LABELS,
  STATUS_LABELS,
  addDays,
  formatLong,
  formatTime,
  londonRange,
  parseQuickAdd,
  snoozeUntilTomorrow,
  todayLondon,
  weekStartOf,
  type Priority,
  type TaskSource,
  type TaskStatus,
} from "@workspace/shared";
import { writeAudit } from "../lib/audit";
import type { FieldChange } from "./history";
import { toTaskView, toTaskViews, type TaskView } from "./taskView";

export type TaskTab = "inbox" | "open" | "now" | "backlog" | "waiting" | "done" | "noise";

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
      : tab === "noise"
        ? [desc(tasksTable.updatedAt), desc(tasksTable.id)]
        : tab === "inbox"
          ? [desc(tasksTable.capturedAt), desc(tasksTable.createdAt)]
          : [sql`${tasksTable.dueDate} asc nulls last`, priorityRank, desc(tasksTable.createdAt)];

  const rows = await db
    .select()
    .from(tasksTable)
    .where(and(...conditions))
    .orderBy(...order)
    .limit(500);

  return toTaskViews(rows);
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
    },
    stats: {
      inboxToTriage: counts.inbox,
      dueThisWeek: counts.dueThisWeek,
      waitingOnOthers: counts.waiting,
      doneThisWeek: counts.doneThisWeek,
    },
  };
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
}

export async function personName(id: number | null): Promise<string | null> {
  if (!id) return null;
  const [p] = await db.select({ name: peopleTable.name }).from(peopleTable).where(eq(peopleTable.id, id));
  if (!p) throw new ValidationError("That person does not exist");
  return p.name;
}

async function projectName(id: number | null): Promise<string | null> {
  if (!id) return null;
  const [p] = await db.select({ name: projectsTable.name }).from(projectsTable).where(eq(projectsTable.id, id));
  if (!p) throw new ValidationError("That project does not exist");
  return p.name;
}

/** Applies an edit, keeps the lifecycle timestamps right, and records each change in the audit trail. */
export async function updateTask(id: number, input: TaskUpdateInput, actor: string): Promise<TaskView> {
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

    if (to === "done" || to === "noise") set.snoozedUntil = null;
  }

  if (changes.length === 0) return toTaskView(current);

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(tasksTable).set(set).where(eq(tasksTable.id, id)).returning();
    await writeAudit(tx, {
      actor,
      action: statusChanged ? "status" : "update",
      entityType: "task",
      entityId: id,
      payload: statusChanged ? { changes, previous: snapshotOf(current) } : { changes },
    });
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
