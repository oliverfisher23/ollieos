import { and, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { db, tasksTable, type Task as TaskRow } from "@workspace/db";
import {
  OPEN_STATUSES,
  parseRef,
  todayLondon,
  toRef,
  type Priority,
  type TaskSource,
  type TaskStatus,
} from "@workspace/shared";
import { updateTask as updateTaskService, ValidationError, type TaskUpdateInput } from "../../services/tasks";
import { captureTask } from "./capture";
import { invalid, notFound, type Writer } from "./errors";
import { resolveLoose, resolvePick, type EntityPick } from "./resolve";
import { visibleNames } from "./retrieve";
import { recordReads, type AiScope } from "./scope";
import { taskVisible } from "./visibility";

export interface TaskOut {
  ref: string;
  title: string;
  kind: "task" | "promise";
  status: TaskStatus;
  priority: Priority;
  due_date: string | null;
  source: TaskSource;
  from_name: string | null;
  project: { ref: string; name: string } | null;
  person: { ref: string; name: string } | null;
  waiting_on: { ref: string; name: string; since: string | null } | null;
  source_url: string | null;
  source_quote: string | null;
  notes: string | null;
  snoozed_until: string | null;
  created_at: string;
  completed_at: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Shapes visible task rows for an AI. Linked projects and people appear only when this scope can see them. */
export async function toTaskOuts(scope: AiScope, rows: TaskRow[]): Promise<TaskOut[]> {
  const refs: { type: "project" | "person"; id: number }[] = [];
  for (const t of rows) {
    if (t.projectId) refs.push({ type: "project", id: t.projectId });
    if (t.personId) refs.push({ type: "person", id: t.personId });
    if (t.waitingOnPersonId) refs.push({ type: "person", id: t.waitingOnPersonId });
  }
  const names = await visibleNames(refs, scope.grants);
  const pick = (type: "project" | "person", id: number | null) => {
    if (!id) return null;
    const ref = toRef(type, id);
    const name = names.get(ref);
    return name ? { ref, name } : null;
  };
  return rows.map((t) => {
    const waiting = pick("person", t.waitingOnPersonId);
    return {
      ref: toRef("task", t.id),
      title: t.title,
      kind: t.kind,
      status: t.status,
      priority: t.priority,
      due_date: t.dueDate,
      source: t.source,
      from_name: t.fromName,
      project: pick("project", t.projectId),
      person: pick("person", t.personId),
      waiting_on: waiting ? { ...waiting, since: iso(t.waitingSince) } : null,
      source_url: t.sourceUrl,
      source_quote: t.sourceQuote,
      notes: t.notes,
      snoozed_until: iso(t.snoozedUntil),
      created_at: t.createdAt.toISOString(),
      completed_at: iso(t.completedAt),
    };
  });
}

/** Visible task rows matching a condition. Hidden rows are never fetched. */
export async function visibleTaskRows(scope: AiScope, where: SQL | undefined, opts: { limit?: number; order?: SQL[] } = {}): Promise<TaskRow[]> {
  const conds = [sql.raw(taskVisible("tasks", scope.grants))];
  if (where) conds.push(where);
  return db
    .select()
    .from(tasksTable)
    .where(and(...conds))
    .orderBy(...(opts.order ?? [sql`${tasksTable.dueDate} asc nulls last`, sql`case ${tasksTable.priority} when 'high' then 0 when 'medium' then 1 else 2 end`, desc(tasksTable.createdAt)]))
    .limit(opts.limit ?? 50);
}

/** One visible task by ref, or not_found. */
export async function loadVisibleTask(scope: AiScope, ref: string): Promise<TaskRow> {
  const r = parseRef(ref);
  if (!r || r.type !== "task") throw invalid(`"${ref}" is not a task ref. Task refs look like task:42.`);
  const [row] = await visibleTaskRows(scope, eq(tasksTable.id, r.id), { limit: 1 });
  if (!row) throw notFound("That task");
  return row;
}

/** Tasks linked to an entity directly or through the links table. */
export function linkedToEntity(type: "project" | "person" | "organisation", id: number): SQL {
  const viaLinks = sql`exists (select 1 from links l where
    (l.from_type = 'task' and l.from_id = ${tasksTable.id} and l.to_type = ${type} and l.to_id = ${id})
    or (l.to_type = 'task' and l.to_id = ${tasksTable.id} and l.from_type = ${type} and l.from_id = ${id}))`;
  if (type === "project") return sql`(${tasksTable.projectId} = ${id} or ${viaLinks})`;
  if (type === "person") return sql`(${tasksTable.personId} = ${id} or ${tasksTable.waitingOnPersonId} = ${id} or ${viaLinks})`;
  return sql`(${viaLinks} or ${tasksTable.personId} in (select id from people where organisation_id = ${id})
    or ${tasksTable.waitingOnPersonId} in (select id from people where organisation_id = ${id}))`;
}

export interface ListTasksInput {
  status?: TaskStatus[];
  kind?: "task" | "promise";
  project?: EntityPick;
  person?: EntityPick;
  due_before?: string;
  limit?: number;
}

export async function listTasksForAi(scope: AiScope, input: ListTasksInput): Promise<{ tasks: TaskOut[] }> {
  const conds: SQL[] = [inArray(tasksTable.status, input.status?.length ? input.status : [...OPEN_STATUSES])];
  if (input.kind) conds.push(eq(tasksTable.kind, input.kind));
  if (input.project) conds.push(linkedToEntity("project", (await resolvePick(scope.grants, input.project, ["project"])).id));
  if (input.person) conds.push(linkedToEntity("person", (await resolvePick(scope.grants, input.person, ["person"])).id));
  if (input.due_before) conds.push(lte(tasksTable.dueDate, input.due_before));
  const rows = await visibleTaskRows(scope, and(...conds), { limit: Math.min(Math.max(input.limit ?? 50, 1), 200) });
  const tasks = await toTaskOuts(scope, rows);
  await recordReads(scope, tasks.map((t) => t.ref), { tool: "list_tasks" });
  return { tasks };
}

/** Visible done tasks completed since a time, newest first. */
export async function doneSince(scope: AiScope, since: Date): Promise<TaskOut[]> {
  const rows = await visibleTaskRows(scope, and(eq(tasksTable.status, "done"), gte(tasksTable.completedAt, since)), {
    limit: 500,
    order: [desc(tasksTable.completedAt)],
  });
  return toTaskOuts(scope, rows);
}

async function pickId(scope: AiScope, pick: EntityPick | null | undefined, kind: "project" | "person"): Promise<number | null | undefined> {
  if (pick === undefined) return undefined;
  if (pick === null) return null;
  return (await resolvePick(scope.grants, pick, [kind])).id;
}

async function oneTaskOut(scope: AiScope, id: number | null): Promise<TaskOut | null> {
  if (!id) return null;
  const rows = await visibleTaskRows(scope, eq(tasksTable.id, id), { limit: 1 });
  return rows.length ? (await toTaskOuts(scope, rows))[0] : null;
}

export interface CreateTaskInput {
  title: string;
  kind?: "task" | "promise";
  status?: "inbox" | "now" | "backlog" | "waiting";
  priority?: Priority;
  due_date?: string;
  project?: EntityPick;
  person?: EntityPick;
  waiting_on?: EntityPick;
  notes?: string;
  source?: TaskSource;
  source_ref?: string;
  source_url?: string;
  source_quote?: string;
  confidential?: boolean;
}

export interface CreateTaskOut {
  task: TaskOut | null;
  duplicate: boolean;
  message?: string;
}

const SAVED_HIDDEN = "Saved. It is confidential, so OllieOS will not show it back.";

export async function createTaskForAi(scope: AiScope, who: Writer, input: CreateTaskInput): Promise<CreateTaskOut> {
  const title = input.title?.trim();
  if (!title) throw invalid("A task needs a title.");
  const [projectId, personId, waitingOnPersonId] = await Promise.all([
    pickId(scope, input.project, "project"),
    pickId(scope, input.person, "person"),
    pickId(scope, input.waiting_on, "person"),
  ]);
  const status = input.status ?? (waitingOnPersonId ? "waiting" : "inbox");
  const result = await captureTask(
    {
      source: input.source ?? "manual",
      sourceRef: input.source_ref,
      kind: input.kind,
      title,
      status,
      priority: input.priority,
      dueDate: input.due_date ?? null,
      notes: input.notes ?? null,
      sourceUrl: input.source_url ?? null,
      sourceQuote: input.source_quote ?? null,
      fromName: who.actor,
      projectId: projectId ?? null,
      personId: personId ?? null,
      waitingOnPersonId: waitingOnPersonId ?? null,
      confidential: input.confidential ?? null,
    },
    who,
    { via: "mcp" },
  );
  const task = await oneTaskOut(scope, result.taskId);
  const out: CreateTaskOut = { task, duplicate: result.outcome === "duplicate" };
  if (!task && result.outcome !== "duplicate") out.message = SAVED_HIDDEN;
  return out;
}

export interface LogPromiseInput {
  title: string;
  to_person?: string;
  project?: string;
  due_date?: string;
  source: TaskSource;
  source_ref?: string;
  source_url?: string;
  source_quote?: string;
}

export async function logPromiseForAi(scope: AiScope, who: Writer, input: LogPromiseInput): Promise<CreateTaskOut & { unmatched: string[] }> {
  const title = input.title?.trim();
  if (!title) throw invalid("A promise needs a title.");
  const unmatched: string[] = [];
  const person = input.to_person ? await resolveLoose(input.to_person, ["person"], scope.grants, true) : null;
  if (input.to_person && !person) unmatched.push(input.to_person);
  const project = input.project ? await resolveLoose(input.project, ["project"], scope.grants, true) : null;
  if (input.project && !project) unmatched.push(input.project);
  const result = await captureTask(
    {
      source: input.source,
      sourceRef: input.source_ref,
      kind: "promise",
      title,
      status: "inbox",
      dueDate: input.due_date ?? null,
      sourceUrl: input.source_url ?? null,
      sourceQuote: input.source_quote ?? null,
      fromName: who.actor,
      personId: person?.id ?? null,
      projectId: project?.id ?? null,
    },
    who,
    { via: "mcp" },
  );
  return { task: await oneTaskOut(scope, result.taskId), duplicate: result.outcome === "duplicate", unmatched };
}

export interface UpdateTaskInput {
  ref: string;
  title?: string;
  status?: TaskStatus;
  priority?: Priority;
  due_date?: string | null;
  project?: EntityPick | null;
  person?: EntityPick | null;
  waiting_on?: EntityPick | null;
  notes_append?: string;
}

/** Edits a visible task. There is no delete: an AI can move a task to Noise or Done instead. */
export async function updateTaskForAi(scope: AiScope, who: Writer, input: UpdateTaskInput): Promise<{ task: TaskOut }> {
  const current = await loadVisibleTask(scope, input.ref);
  const [projectId, personId, waitingOnPersonId] = await Promise.all([
    pickId(scope, input.project, "project"),
    pickId(scope, input.person, "person"),
    pickId(scope, input.waiting_on, "person"),
  ]);
  const patch: TaskUpdateInput = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.status !== undefined) patch.status = input.status;
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.due_date !== undefined) patch.dueDate = input.due_date;
  if (projectId !== undefined) patch.projectId = projectId;
  if (personId !== undefined) patch.personId = personId;
  if (waitingOnPersonId !== undefined) patch.waitingOnPersonId = waitingOnPersonId;
  if (input.notes_append?.trim()) {
    const stamp = `${todayLondon()}, ${who.actor}: ${input.notes_append.trim()}`;
    patch.notes = current.notes ? `${current.notes}\n\n${stamp}` : stamp;
  }
  try {
    await updateTaskService(current.id, patch, who.actor, who.clientId);
  } catch (err) {
    if (err instanceof ValidationError) throw invalid(err.message);
    throw err;
  }
  const task = await oneTaskOut(scope, current.id);
  if (!task) throw notFound("That task");
  return { task };
}
