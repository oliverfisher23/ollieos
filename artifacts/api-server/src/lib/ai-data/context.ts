/**
 * Structured reads for MCP tools, MCP resources and ingest GET routes (build plan section 5).
 * Every query carries the visibility filter in its WHERE clause, every result is checked again
 * with sanitiseRefs, and every item handed out is logged with recordReads.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import {
  activityTable,
  calendarEventsTable,
  db,
  decisionsTable,
  factsTable,
  noiseRulesTable,
  notesTable,
  organisationsTable,
  peopleTable,
  projectsTable,
  sweepRunsTable,
  tasksTable,
  type Task as TaskRow,
} from "@workspace/db";
import { OPEN_STATUSES, londonRange, parseRef, todayLondon, toRef, type TaskStatus } from "@workspace/shared";
import {
  activityVisible,
  decisionVisible,
  factVisible,
  noteVisible,
  organisationVisible,
  personVisible,
  projectVisible,
  taskVisible,
  type Grants,
} from "./visibility";
import { recordReads, sanitiseRefs, type AiScope } from "./scope";
import { searchItems, type SearchType } from "./search";

export type PickType = "project" | "person" | "organisation";
export const PICK_TYPES: readonly PickType[] = ["project", "person", "organisation"];

/** How an AI names a project, person or organisation: a ref, a slug or a name. */
export interface EntityPick {
  ref?: string;
  slug?: string;
  name?: string;
  type?: PickType;
}

export interface Picked {
  type: PickType;
  id: number;
  name: string;
  slug: string;
}

const TABLES = { project: projectsTable, person: peopleTable, organisation: organisationsTable } as const;

function visibleSql(type: PickType, g: Grants): SQL {
  if (type === "project") return sql.raw(projectVisible("projects", g));
  if (type === "person") return sql.raw(personVisible("people", g));
  return sql.raw(organisationVisible("organisations", g));
}

/**
 * Finds a visible project, person or organisation. Hidden and missing items both come back as
 * null, so a caller can never tell them apart (build plan section 5, not_found).
 * Order: ref, then slug, then exact name (or email for people), then a single partial name match.
 */
export async function resolvePick(
  scope: AiScope,
  pick: EntityPick | string | null | undefined,
  allowed: readonly PickType[] = PICK_TYPES,
  opts: { partial?: boolean } = {},
): Promise<Picked | null> {
  if (!pick) return null;
  const p: EntityPick = typeof pick === "string" ? { name: pick } : pick;
  const types = p.type ? allowed.filter((t) => t === p.type) : [...allowed];
  if (!types.length) return null;
  const g = scope.grants;

  const one = async (type: PickType, where: SQL, limit = 1) => {
    const t = TABLES[type];
    const rows = await db
      .select({ id: t.id, name: t.name, slug: t.slug })
      .from(t)
      .where(and(where, visibleSql(type, g)))
      .limit(limit);
    return rows.map((r) => ({ type, ...r }));
  };

  const refText = p.ref ?? (p.name && parseRef(p.name.trim()) ? p.name.trim() : undefined);
  if (refText) {
    const ref = parseRef(refText.trim());
    if (!ref || !types.includes(ref.type as PickType)) return null;
    const type = ref.type as PickType;
    return (await one(type, eq(TABLES[type].id, ref.id)))[0] ?? null;
  }
  const slug = (p.slug ?? p.name)?.trim().toLowerCase();
  if (slug) {
    for (const type of types) {
      const hit = (await one(type, eq(TABLES[type].slug, slug)))[0];
      if (hit) return hit;
    }
  }
  const name = p.name?.trim().toLowerCase();
  if (!name) return null;
  for (const type of types) {
    const t = TABLES[type];
    const exact = type === "person" ? sql`(lower(${peopleTable.name}) = ${name} or lower(${peopleTable.email}) = ${name})` : sql`lower(${t.name}) = ${name}`;
    const hits = await one(type, exact, 2);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;
  }
  if (opts.partial === false || name.length < 3) return null;
  const partial: Picked[] = [];
  for (const type of types) {
    const t = TABLES[type];
    partial.push(...(await one(type, sql`${t.name} ilike ${"%" + name.replace(/[%_\\]/g, "\\$&") + "%"}`, 2)));
  }
  return partial.length === 1 ? partial[0] : null;
}

/* ---------- Tasks ---------- */

export interface NamedRef {
  ref: string;
  name: string;
}

export interface TaskOut {
  ref: string;
  title: string;
  kind: "task" | "promise";
  status: TaskStatus;
  priority: "high" | "medium" | "low";
  due_date: string | null;
  source: string;
  from_name: string | null;
  snippet: string | null;
  notes: string | null;
  project: NamedRef | null;
  person: NamedRef | null;
  waiting_on: (NamedRef & { since: string | null }) | null;
  source_url: string | null;
  snoozed_until: string | null;
  created_at: string;
  completed_at: string | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

/** Names for linked projects and people, only where the scope can see them. */
async function visibleNames(scope: AiScope, projectIds: number[], personIds: number[]) {
  const g = scope.grants;
  const [projects, people] = await Promise.all([
    projectIds.length
      ? db.select({ id: projectsTable.id, name: projectsTable.name }).from(projectsTable).where(and(inArray(projectsTable.id, projectIds), sql.raw(projectVisible("projects", g))))
      : [],
    personIds.length
      ? db.select({ id: peopleTable.id, name: peopleTable.name }).from(peopleTable).where(and(inArray(peopleTable.id, personIds), sql.raw(personVisible("people", g))))
      : [],
  ]);
  return { projects: new Map(projects.map((r) => [r.id, r.name])), people: new Map(people.map((r) => [r.id, r.name])) };
}

/** Shapes task rows for an AI. Rows must already be filtered for visibility; links to hidden items are dropped. */
export async function toTaskOuts(scope: AiScope, rows: TaskRow[]): Promise<TaskOut[]> {
  const projectIds = [...new Set(rows.map((r) => r.projectId).filter((x): x is number => x != null))];
  const personIds = [...new Set(rows.flatMap((r) => [r.personId, r.waitingOnPersonId]).filter((x): x is number => x != null))];
  const names = await visibleNames(scope, projectIds, personIds);
  const named = (type: "project" | "person", id: number | null): NamedRef | null => {
    if (id == null) return null;
    const name = (type === "project" ? names.projects : names.people).get(id);
    return name ? { ref: toRef(type, id), name } : null;
  };
  return rows.map((t) => {
    const waiting = named("person", t.waitingOnPersonId);
    return {
      ref: toRef("task", t.id),
      title: t.title,
      kind: t.kind,
      status: t.status,
      priority: t.priority,
      due_date: t.dueDate,
      source: t.source,
      from_name: t.fromName,
      snippet: t.snippet,
      notes: t.notes,
      project: named("project", t.projectId),
      person: named("person", t.personId),
      waiting_on: waiting ? { ...waiting, since: iso(t.waitingSince) } : null,
      source_url: t.sourceUrl,
      snoozed_until: iso(t.snoozedUntil),
      created_at: t.createdAt.toISOString(),
      completed_at: iso(t.completedAt),
    };
  });
}

function taskRefsOf(tasks: TaskOut[]): string[] {
  return tasks.map((t) => t.ref);
}

/** Visible task rows matching a condition. */
async function visibleTasks(scope: AiScope, where: SQL | undefined, opts: { limit?: number; order?: SQL[] } = {}): Promise<TaskRow[]> {
  return db
    .select()
    .from(tasksTable)
    .where(and(where, sql.raw(taskVisible("tasks", scope.grants))))
    .orderBy(...(opts.order ?? [sql`${tasksTable.dueDate} asc nulls last`, desc(tasksTable.createdAt)]))
    .limit(opts.limit ?? 200);
}

/** One visible task by ref, or null when hidden or missing. Used before any AI write to a task. */
export async function visibleTaskId(scope: AiScope, ref: string): Promise<number | null> {
  const r = parseRef(ref.trim());
  if (!r || r.type !== "task") return null;
  const [row] = await db
    .select({ id: tasksTable.id })
    .from(tasksTable)
    .where(and(eq(tasksTable.id, r.id), sql.raw(taskVisible("tasks", scope.grants))));
  return row?.id ?? null;
}

/** A single task as the AI may see it, or null when it is hidden (for example just created as confidential). */
export async function taskForAi(scope: AiScope, id: number, via: string): Promise<TaskOut | null> {
  const rows = await visibleTasks(scope, eq(tasksTable.id, id), { limit: 1 });
  const out = await toTaskOuts(scope, rows);
  await recordReads(scope, taskRefsOf(out), { via });
  return out[0] ?? null;
}

/** Whether a fact is visible: used to check `supersedes` before replacing a fact. */
export async function visibleFact(scope: AiScope, ref: string): Promise<{ id: number; entityType: string; entityId: number } | null> {
  const r = parseRef(ref.trim());
  if (!r || r.type !== "fact") return null;
  const [row] = await db
    .select({ id: factsTable.id, entityType: factsTable.entityType, entityId: factsTable.entityId, supersededBy: factsTable.supersededBy })
    .from(factsTable)
    .where(and(eq(factsTable.id, r.id), sql.raw(factVisible("facts", scope.grants))));
  return row && row.supersededBy == null ? { id: row.id, entityType: row.entityType, entityId: row.entityId } : null;
}

export interface ListTasksInput {
  status?: TaskStatus[];
  kind?: "task" | "promise";
  project?: EntityPick;
  person?: EntityPick;
  due_before?: string;
  limit?: number;
}

/** list_tasks. A project or person the scope cannot see gives not_found, like a missing one. */
export async function listTasksForAi(scope: AiScope, input: ListTasksInput): Promise<{ tasks: TaskOut[] } | { error: "not_found"; message: string }> {
  const conds: (SQL | undefined)[] = [inArray(tasksTable.status, input.status?.length ? input.status : [...OPEN_STATUSES])];
  if (input.kind) conds.push(eq(tasksTable.kind, input.kind));
  if (input.project) {
    const p = await resolvePick(scope, input.project, ["project"]);
    if (!p) return { error: "not_found", message: "No project matches that." };
    conds.push(
      or(
        eq(tasksTable.projectId, p.id),
        sql`exists (select 1 from links l where (l.from_type = 'task' and l.from_id = ${tasksTable.id} and l.to_type = 'project' and l.to_id = ${p.id}) or (l.to_type = 'task' and l.to_id = ${tasksTable.id} and l.from_type = 'project' and l.from_id = ${p.id}))`,
      ),
    );
  }
  if (input.person) {
    const p = await resolvePick(scope, input.person, ["person"]);
    if (!p) return { error: "not_found", message: "No person matches that." };
    conds.push(or(eq(tasksTable.personId, p.id), eq(tasksTable.waitingOnPersonId, p.id)));
  }
  if (input.due_before) conds.push(lt(tasksTable.dueDate, input.due_before));
  const rows = await visibleTasks(scope, and(...conds), { limit: Math.min(Math.max(input.limit ?? 50, 1), 200) });
  const tasks = await toTaskOuts(scope, rows);
  await recordReads(scope, taskRefsOf(tasks), { via: "list_tasks" });
  return { tasks };
}

/* ---------- Search ---------- */

export interface SearchOut {
  results: { type: string; ref: string; title: string; snippet: string | null; slug: string | null }[];
}

/** search: the shared full-text search over visible items only, logged as one search. */
export async function searchForAi(scope: AiScope, query: string, types: readonly SearchType[] | undefined, limit = 20): Promise<SearchOut> {
  const n = Math.min(Math.max(Math.trunc(limit) || 20, 1), 50);
  const hits = await searchItems({ q: query, mode: "ask", visibleOnly: true, scope, types, limitPerType: n });
  const refs = await sanitiseRefs(scope, hits.map((h) => toRef(h.type, h.id)));
  const ok = new Set(refs);
  const results = hits
    .filter((h) => ok.has(toRef(h.type, h.id)))
    .slice(0, n)
    .map((h) => ({ type: h.type, ref: toRef(h.type, h.id), title: h.title, snippet: h.snippet, slug: h.slug }));
  await recordReads(scope, results.map((r) => r.ref), { via: "search", query: query.slice(0, 200) }, "search");
  return { results };
}

/* ---------- get_context ---------- */

export interface ContextOut {
  entity: {
    ref: string;
    type: PickType;
    name: string;
    slug: string;
    area?: string | null;
    status?: string | null;
    role?: string | null;
    email?: string | null;
    organisation?: NamedRef | null;
  };
  summary: string | null;
  facts: { ref: string; text: string; source: string | null; created_at: string }[];
  decisions: { ref: string; text: string; decided_at: string; decided_by: string | null }[];
  open_tasks: TaskOut[];
  promises: TaskOut[];
  waiting_on_them: TaskOut[];
  people: { ref: string; name: string; role: string | null; organisation: string | null; email: string | null }[];
  projects: NamedRef[];
  notes: { ref: string; title: string | null; body: string; created_at: string }[];
  recent_activity: { ref: string; kind: string; summary: string; occurred_at: string; source_url: string | null }[];
}

/** Ids of `other` linked to an item, either way round. */
async function linked(type: string, id: number, other: string): Promise<number[]> {
  const rows = await db.execute(sql`
    select to_id as id from links where from_type = ${type} and from_id = ${id} and to_type = ${other}
    union select from_id as id from links where to_type = ${type} and to_id = ${id} and from_type = ${other}`);
  return (rows.rows as { id: number }[]).map((r) => Number(r.id));
}

/** Everything about one project, person or organisation, filtered. Null when hidden or missing. */
export async function getContext(scope: AiScope, pick: EntityPick | string, via = "get_context"): Promise<ContextOut | null> {
  const found = await resolvePick(scope, pick);
  if (!found) return null;
  const g = scope.grants;
  const { type, id } = found;

  let entity: ContextOut["entity"];
  let summary: string | null;
  if (type === "project") {
    const [p] = await db.select().from(projectsTable).where(eq(projectsTable.id, id));
    entity = { ref: toRef(type, id), type, name: p.name, slug: p.slug, area: p.area, status: p.status };
    summary = p.summary;
  } else if (type === "person") {
    const [p] = await db.select().from(peopleTable).where(eq(peopleTable.id, id));
    let organisation: NamedRef | null = null;
    if (p.organisationId != null) {
      const [o] = await db
        .select({ id: organisationsTable.id, name: organisationsTable.name })
        .from(organisationsTable)
        .where(and(eq(organisationsTable.id, p.organisationId), sql.raw(organisationVisible("organisations", g))));
      if (o) organisation = { ref: toRef("organisation", o.id), name: o.name };
    }
    entity = { ref: toRef(type, id), type, name: p.name, slug: p.slug, role: p.role, email: p.email, organisation };
    summary = p.relationshipSummary;
  } else {
    const [o] = await db.select().from(organisationsTable).where(eq(organisationsTable.id, id));
    entity = { ref: toRef(type, id), type, name: o.name, slug: o.slug };
    summary = o.summary;
  }

  // Related ids through the links table and direct columns.
  const [linkedPeople, linkedProjects, linkedDecisions, linkedTasks, linkedActivity] = await Promise.all([
    type === "person" ? Promise.resolve([] as number[]) : linked(type, id, "person"),
    type === "project" ? Promise.resolve([] as number[]) : linked(type, id, "project"),
    linked(type, id, "decision"),
    linked(type, id, "task"),
    linked(type, id, "activity"),
  ]);
  let peopleIds = linkedPeople;
  if (type === "organisation") {
    const members = await db.select({ id: peopleTable.id }).from(peopleTable).where(eq(peopleTable.organisationId, id));
    peopleIds = [...new Set([...peopleIds, ...members.map((m) => m.id)])];
  }

  const taskWhere: SQL | undefined =
    type === "project"
      ? or(eq(tasksTable.projectId, id), linkedTasks.length ? inArray(tasksTable.id, linkedTasks) : undefined)
      : type === "person"
        ? or(eq(tasksTable.personId, id), eq(tasksTable.waitingOnPersonId, id), linkedTasks.length ? inArray(tasksTable.id, linkedTasks) : undefined)
        : or(
            peopleIds.length ? inArray(tasksTable.personId, peopleIds) : undefined,
            peopleIds.length ? inArray(tasksTable.waitingOnPersonId, peopleIds) : undefined,
            linkedTasks.length ? inArray(tasksTable.id, linkedTasks) : sql`false`,
          );

  const [factRows, decisionRows, taskRows, peopleRows, projectRows, noteRows, activityRows] = await Promise.all([
    db
      .select()
      .from(factsTable)
      .where(and(eq(factsTable.entityType, type), eq(factsTable.entityId, id), isNull(factsTable.supersededBy), sql.raw(factVisible("facts", g))))
      .orderBy(asc(factsTable.createdAt)),
    db
      .select()
      .from(decisionsTable)
      .where(
        and(
          or(type === "project" ? eq(decisionsTable.projectId, id) : undefined, linkedDecisions.length ? inArray(decisionsTable.id, linkedDecisions) : sql`false`),
          sql.raw(decisionVisible("decisions", g)),
        ),
      )
      .orderBy(desc(decisionsTable.decidedAt))
      .limit(50),
    visibleTasks(scope, and(inArray(tasksTable.status, [...OPEN_STATUSES]), taskWhere), { limit: 100 }),
    peopleIds.length
      ? db
          .select({ id: peopleTable.id, name: peopleTable.name, role: peopleTable.role, email: peopleTable.email, organisationId: peopleTable.organisationId })
          .from(peopleTable)
          .where(and(inArray(peopleTable.id, peopleIds), sql.raw(personVisible("people", g))))
          .orderBy(asc(peopleTable.name))
      : [],
    linkedProjects.length
      ? db
          .select({ id: projectsTable.id, name: projectsTable.name })
          .from(projectsTable)
          .where(and(inArray(projectsTable.id, linkedProjects), sql.raw(projectVisible("projects", g))))
          .orderBy(asc(projectsTable.name))
      : [],
    db
      .select()
      .from(notesTable)
      .where(and(eq(notesTable.entityType, type), eq(notesTable.entityId, id), sql.raw(noteVisible("notes", g))))
      .orderBy(desc(notesTable.createdAt))
      .limit(20),
    db
      .select()
      .from(activityTable)
      .where(
        and(
          or(and(eq(activityTable.entityType, type), eq(activityTable.entityId, id)), linkedActivity.length ? inArray(activityTable.id, linkedActivity) : undefined),
          sql.raw(activityVisible("activity", g)),
        ),
      )
      .orderBy(desc(activityTable.occurredAt))
      .limit(20),
  ]);

  const orgIds = [...new Set(peopleRows.map((p) => p.organisationId).filter((x): x is number => x != null))];
  const orgNames = new Map(
    (orgIds.length
      ? await db
          .select({ id: organisationsTable.id, name: organisationsTable.name })
          .from(organisationsTable)
          .where(and(inArray(organisationsTable.id, orgIds), sql.raw(organisationVisible("organisations", g))))
      : []
    ).map((o) => [o.id, o.name]),
  );

  const tasks = await toTaskOuts(scope, taskRows);
  const out: ContextOut = {
    entity,
    summary,
    facts: factRows.map((f) => ({ ref: toRef("fact", f.id), text: f.text, source: f.source, created_at: f.createdAt.toISOString() })),
    decisions: decisionRows.map((d) => ({ ref: toRef("decision", d.id), text: d.text, decided_at: d.decidedAt, decided_by: d.decidedBy })),
    open_tasks: tasks.filter((t) => t.kind === "task" && t.status !== "waiting"),
    promises: tasks.filter((t) => t.kind === "promise"),
    waiting_on_them: tasks.filter((t) => t.kind === "task" && t.status === "waiting"),
    people: peopleRows.map((p) => ({
      ref: toRef("person", p.id),
      name: p.name,
      role: p.role,
      email: p.email,
      organisation: p.organisationId != null ? (orgNames.get(p.organisationId) ?? null) : null,
    })),
    projects: projectRows.map((p) => ({ ref: toRef("project", p.id), name: p.name })),
    notes: noteRows.map((n) => ({ ref: toRef("note", n.id), title: n.title, body: n.body, created_at: n.createdAt.toISOString() })),
    recent_activity: activityRows.map((a) => ({
      ref: toRef("activity", a.id),
      kind: a.kind,
      summary: a.summary,
      occurred_at: a.occurredAt.toISOString(),
      source_url: a.sourceUrl,
    })),
  };

  // Second check: drop anything that is not visible, in case a join above is ever wrong.
  const all = contextRefs(out);
  const ok = new Set(await sanitiseRefs(scope, all));
  const keep = <T extends { ref: string }>(xs: T[]) => xs.filter((x) => ok.has(x.ref));
  out.facts = keep(out.facts);
  out.decisions = keep(out.decisions);
  out.open_tasks = keep(out.open_tasks);
  out.promises = keep(out.promises);
  out.waiting_on_them = keep(out.waiting_on_them);
  out.people = keep(out.people);
  out.projects = keep(out.projects);
  out.notes = keep(out.notes);
  out.recent_activity = keep(out.recent_activity);
  if (out.entity.organisation && !ok.has(out.entity.organisation.ref)) out.entity.organisation = null;

  await recordReads(scope, contextRefs(out), { via });
  return out;
}

function contextRefs(c: ContextOut): string[] {
  return [
    c.entity.ref,
    ...(c.entity.organisation ? [c.entity.organisation.ref] : []),
    ...c.facts.map((x) => x.ref),
    ...c.decisions.map((x) => x.ref),
    ...c.open_tasks.map((x) => x.ref),
    ...c.promises.map((x) => x.ref),
    ...c.waiting_on_them.map((x) => x.ref),
    ...c.people.map((x) => x.ref),
    ...c.projects.map((x) => x.ref),
    ...c.notes.map((x) => x.ref),
    ...c.recent_activity.map((x) => x.ref),
  ];
}

/* ---------- Today (ollieos://today) ---------- */

export interface CalendarOut {
  title: string;
  starts_at: string;
  ends_at: string;
  personal: boolean;
  location: string | null;
  attendees: string[];
  project: NamedRef | null;
  people: NamedRef[];
}

/**
 * Calendar events for a London day range, without any event tied to a hidden project or whose
 * people are all hidden. Events have no confidential flag of their own.
 */
async function calendarFor(scope: AiScope, start: Date, end: Date): Promise<CalendarOut[]> {
  const rows = await db
    .select()
    .from(calendarEventsTable)
    .where(and(gte(calendarEventsTable.startsAt, start), lt(calendarEventsTable.startsAt, end)))
    .orderBy(asc(calendarEventsTable.startsAt));
  const projectIds = [...new Set(rows.map((r) => r.projectId).filter((x): x is number => x != null))];
  const personIds = [...new Set(rows.flatMap((r) => r.personIds))];
  const names = await visibleNames(scope, projectIds, personIds);
  return rows
    .filter((r) => (r.projectId == null || names.projects.has(r.projectId)) && (!r.personIds.length || r.personIds.some((p) => names.people.has(p))))
    .map((r) => ({
      title: r.title,
      starts_at: r.startsAt.toISOString(),
      ends_at: r.endsAt.toISOString(),
      personal: r.personal,
      location: r.location,
      attendees: r.attendees,
      project: r.projectId != null ? { ref: toRef("project", r.projectId), name: names.projects.get(r.projectId)! } : null,
      people: r.personIds.filter((p) => names.people.has(p)).map((p) => ({ ref: toRef("person", p), name: names.people.get(p)! })),
    }));
}

export interface TodayOut {
  date: string;
  last_sweep_at: string | null;
  inbox_count: number;
  now: TaskOut[];
  waiting_on: TaskOut[];
  promises: TaskOut[];
  done_this_week: TaskOut[];
  calendar: CalendarOut[];
}

/** The Home summary for an AI, filtered. */
export async function todayForAi(scope: AiScope, now = new Date()): Promise<TodayOut> {
  const today = todayLondon(now);
  const day = londonRange(today, 1);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const notSnoozed = sql`(${tasksTable.snoozedUntil} is null or ${tasksTable.snoozedUntil} <= ${now.toISOString()})`;
  const [inbox, nowRows, waitingRows, promiseRows, doneRows, lastSweep, calendar] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(tasksTable)
      .where(and(eq(tasksTable.status, "inbox"), sql.raw(taskVisible("tasks", scope.grants)))),
    visibleTasks(scope, and(eq(tasksTable.status, "now"), eq(tasksTable.kind, "task"), notSnoozed), { limit: 50 }),
    visibleTasks(scope, eq(tasksTable.status, "waiting"), { limit: 50 }),
    visibleTasks(scope, and(eq(tasksTable.kind, "promise"), inArray(tasksTable.status, [...OPEN_STATUSES])), { limit: 50 }),
    visibleTasks(scope, and(eq(tasksTable.status, "done"), gte(tasksTable.completedAt, weekAgo)), { limit: 50, order: [desc(tasksTable.completedAt)] }),
    db
      .select({ at: sweepRunsTable.finishedAt })
      .from(sweepRunsTable)
      .where(sql`${sweepRunsTable.finishedAt} is not null`)
      .orderBy(desc(sweepRunsTable.finishedAt))
      .limit(1),
    calendarFor(scope, day.start, day.end),
  ]);
  const [nowT, waitingT, promisesT, doneT] = await Promise.all([
    toTaskOuts(scope, nowRows),
    toTaskOuts(scope, waitingRows),
    toTaskOuts(scope, promiseRows),
    toTaskOuts(scope, doneRows),
  ]);
  const out: TodayOut = {
    date: today,
    last_sweep_at: iso(lastSweep[0]?.at ?? null),
    inbox_count: inbox[0]?.n ?? 0,
    now: nowT,
    waiting_on: waitingT,
    promises: promisesT,
    done_this_week: doneT,
    calendar,
  };
  await recordReads(scope, [...nowT, ...waitingT, ...promisesT, ...doneT].map((t) => t.ref), { via: "today" });
  return out;
}

/* ---------- Ingest GET routes ---------- */

/** Open tasks, so the sweep can avoid near-duplicates. */
export async function openTasksForIngest(scope: AiScope): Promise<TaskOut[]> {
  const rows = await visibleTasks(scope, inArray(tasksTable.status, [...OPEN_STATUSES]), { limit: 1000 });
  const out = await toTaskOuts(scope, rows);
  await recordReads(scope, taskRefsOf(out), { via: "ingest_open_tasks" });
  return out;
}

/** Done tasks since a time, for the weekly update. */
export async function doneSinceForIngest(scope: AiScope, since: Date): Promise<TaskOut[]> {
  const rows = await visibleTasks(scope, and(eq(tasksTable.status, "done"), gte(tasksTable.completedAt, since)), {
    limit: 1000,
    order: [desc(tasksTable.completedAt)],
  });
  const out = await toTaskOuts(scope, rows);
  await recordReads(scope, taskRefsOf(out), { via: "ingest_done" });
  return out;
}

/** Enabled noise rules. Rules hold no confidential content (a sender, domain, channel or phrase). */
export async function enabledNoiseRules() {
  const rows = await db.select().from(noiseRulesTable).where(eq(noiseRulesTable.enabled, true)).orderBy(asc(noiseRulesTable.id));
  return rows.map((r) => ({ id: r.id, match_type: r.matchType, match_value: r.matchValue, source: r.source }));
}

/** When the last successful sweep finished (the ingest cursor). */
export async function lastSweepFinishedAt(): Promise<Date | null> {
  const [row] = await db
    .select({ at: sweepRunsTable.finishedAt })
    .from(sweepRunsTable)
    .where(sql`${sweepRunsTable.finishedAt} is not null and jsonb_array_length(${sweepRunsTable.errors}) = 0`)
    .orderBy(desc(sweepRunsTable.finishedAt))
    .limit(1);
  return row?.at ?? null;
}
