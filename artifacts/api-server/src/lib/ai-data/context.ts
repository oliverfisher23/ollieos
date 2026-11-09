import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, or, sql, type SQL } from "drizzle-orm";
import {
  activityTable,
  calendarEventsTable,
  db,
  decisionsTable,
  factsTable,
  notesTable,
  organisationsTable,
  peopleTable,
  projectsTable,
  sweepRunsTable,
  tasksTable,
} from "@workspace/db";
import { OPEN_STATUSES, londonRange, todayLondon, toRef, weekStartOf, type TaskStatus } from "@workspace/shared";
import { notFound } from "./errors";
import { resolvePick, type EntityKind, type EntityPick } from "./resolve";
import { recordReads, type AiScope } from "./scope";
import { linkedToEntity, toTaskOuts, visibleTaskRows, type TaskOut } from "./tasks";
import {
  activityVisible,
  decisionVisible,
  factVisible,
  noteVisible,
  organisationVisible,
  personVisible,
  projectVisible,
  taskVisible,
} from "./visibility";

const OPEN = [...OPEN_STATUSES] as TaskStatus[];
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export interface ContextOut {
  entity: {
    ref: string;
    type: EntityKind;
    name: string;
    slug: string;
    area?: string | null;
    status?: string | null;
    role?: string | null;
    email?: string | null;
    organisation?: { ref: string; name: string } | null;
  };
  summary: string | null;
  facts: { ref: string; text: string; source: string | null; created_at: string }[];
  decisions: { ref: string; text: string; decided_at: string; decided_by: string | null }[];
  open_tasks: TaskOut[];
  promises: TaskOut[];
  waiting_on_them: TaskOut[];
  people: { ref: string; name: string; role: string | null; organisation: string | null }[];
  projects: { ref: string; name: string }[];
  notes: { ref: string; title: string | null; body: string; created_at: string }[];
  recent_activity: { ref: string; kind: string; summary: string; occurred_at: string; source_url: string | null }[];
}

/** Ids of one kind linked to an entity through the links table, either direction. */
function linkedIds(fromType: string, fromId: number, toType: string): SQL {
  return sql`(select l.to_id from links l where l.from_type = ${fromType} and l.from_id = ${fromId} and l.to_type = ${toType}
    union select l.from_id from links l where l.to_type = ${fromType} and l.to_id = ${fromId} and l.from_type = ${toType})`;
}

/**
 * Everything about one project, person or organisation that this scope can see.
 * The entity itself must be visible, otherwise not_found.
 */
export async function getContext(scope: AiScope, pick: EntityPick): Promise<ContextOut> {
  const found = await resolvePick(scope.grants, pick);
  const g = scope.grants;
  const { type, id } = found;
  const v = {
    project: sql.raw(projectVisible("projects", g)),
    person: sql.raw(personVisible("people", g)),
    organisation: sql.raw(organisationVisible("organisations", g)),
    decision: sql.raw(decisionVisible("decisions", g)),
    note: sql.raw(noteVisible("notes", g)),
    fact: sql.raw(factVisible("facts", g)),
    activity: sql.raw(activityVisible("activity", g)),
  };

  let entity: ContextOut["entity"];
  let summary: string | null;
  if (type === "project") {
    const [p] = await db.select().from(projectsTable).where(and(eq(projectsTable.id, id), v.project));
    if (!p) throw notFound("That project");
    entity = { ref: toRef("project", p.id), type, name: p.name, slug: p.slug, area: p.area, status: p.status };
    summary = p.summary;
  } else if (type === "person") {
    const [p] = await db.select().from(peopleTable).where(and(eq(peopleTable.id, id), v.person));
    if (!p) throw notFound("That person");
    const [org] = p.organisationId
      ? await db.select({ id: organisationsTable.id, name: organisationsTable.name }).from(organisationsTable).where(and(eq(organisationsTable.id, p.organisationId), v.organisation))
      : [];
    entity = {
      ref: toRef("person", p.id),
      type,
      name: p.name,
      slug: p.slug,
      role: p.role,
      email: p.email,
      organisation: org ? { ref: toRef("organisation", org.id), name: org.name } : null,
    };
    summary = p.relationshipSummary;
  } else {
    const [o] = await db.select().from(organisationsTable).where(and(eq(organisationsTable.id, id), v.organisation));
    if (!o) throw notFound("That organisation");
    entity = { ref: toRef("organisation", o.id), type, name: o.name, slug: o.slug };
    summary = o.summary;
  }

  const onEntity = <T extends { entityType: unknown; entityId: unknown }>(t: T) =>
    and(eq(t.entityType as typeof factsTable.entityType, type), eq(t.entityId as typeof factsTable.entityId, id));

  const peopleWhere: SQL | null =
    type === "project"
      ? sql`(${peopleTable.id} in ${linkedIds("project", id, "person")} or ${peopleTable.id} in (
          select person_id from tasks where project_id = ${id} and person_id is not null
          union select waiting_on_person_id from tasks where project_id = ${id} and waiting_on_person_id is not null))`
      : type === "organisation"
        ? sql`(${peopleTable.organisationId} = ${id} or ${peopleTable.id} in ${linkedIds("organisation", id, "person")})`
        : null;
  const projectsWhere: SQL | null =
    type === "person"
      ? sql`(${projectsTable.id} in ${linkedIds("person", id, "project")} or ${projectsTable.id} in (
          select project_id from tasks where (person_id = ${id} or waiting_on_person_id = ${id}) and project_id is not null))`
      : type === "organisation"
        ? sql`${projectsTable.id} in ${linkedIds("organisation", id, "project")}`
        : null;

  const activityWhere = or(
    and(eq(activityTable.entityType, type), eq(activityTable.entityId, id)),
    sql`${activityTable.id} in ${linkedIds(type, id, "activity")}`,
    type === "organisation"
      ? sql`(${activityTable.entityType} = 'person' and ${activityTable.entityId} in (select id from people where organisation_id = ${id}))`
      : undefined,
  );

  const [facts, decisions, taskRows, people, projects, notes, activity] = await Promise.all([
    db
      .select()
      .from(factsTable)
      .where(and(onEntity(factsTable), isNull(factsTable.supersededBy), v.fact))
      .orderBy(asc(factsTable.createdAt)),
    type === "project"
      ? db.select().from(decisionsTable).where(and(eq(decisionsTable.projectId, id), v.decision)).orderBy(desc(decisionsTable.decidedAt)).limit(30)
      : Promise.resolve([]),
    visibleTaskRows(scope, and(inArray(tasksTable.status, OPEN), linkedToEntity(type, id)), { limit: 100 }),
    peopleWhere
      ? db
          .select({ id: peopleTable.id, name: peopleTable.name, role: peopleTable.role, org: peopleTable.organisationId })
          .from(peopleTable)
          .where(and(peopleWhere, v.person))
          .orderBy(asc(peopleTable.name))
          .limit(50)
      : Promise.resolve([]),
    projectsWhere
      ? db.select({ id: projectsTable.id, name: projectsTable.name }).from(projectsTable).where(and(projectsWhere, v.project)).orderBy(asc(projectsTable.name)).limit(50)
      : Promise.resolve([]),
    db.select().from(notesTable).where(and(onEntity(notesTable), v.note)).orderBy(desc(notesTable.updatedAt)).limit(20),
    db.select().from(activityTable).where(and(activityWhere, v.activity)).orderBy(desc(activityTable.occurredAt)).limit(20),
  ]);

  const orgIds = [...new Set(people.map((p) => p.org).filter((x): x is number => !!x))];
  const orgNames = new Map(
    orgIds.length
      ? (
          await db
            .select({ id: organisationsTable.id, name: organisationsTable.name })
            .from(organisationsTable)
            .where(and(inArray(organisationsTable.id, orgIds), v.organisation))
        ).map((o) => [o.id, o.name])
      : [],
  );

  const tasks = await toTaskOuts(scope, taskRows);
  const waitingOnThem = tasks.filter((t) => t.status === "waiting" && (type !== "person" || t.waiting_on?.ref === toRef("person", id)));
  const promises = tasks.filter((t) => t.kind === "promise" && !waitingOnThem.includes(t));
  const openTasks = tasks.filter((t) => !waitingOnThem.includes(t) && !promises.includes(t));

  const out: ContextOut = {
    entity,
    summary,
    facts: facts.map((f) => ({ ref: toRef("fact", f.id), text: f.text, source: f.source, created_at: f.createdAt.toISOString() })),
    decisions: decisions.map((d) => ({ ref: toRef("decision", d.id), text: d.text, decided_at: d.decidedAt, decided_by: d.decidedBy })),
    open_tasks: openTasks,
    promises,
    waiting_on_them: waitingOnThem,
    people: people.map((p) => ({ ref: toRef("person", p.id), name: p.name, role: p.role, organisation: p.org ? (orgNames.get(p.org) ?? null) : null })),
    projects: projects.map((p) => ({ ref: toRef("project", p.id), name: p.name })),
    notes: notes.map((n) => ({ ref: toRef("note", n.id), title: n.title, body: n.body, created_at: n.createdAt.toISOString() })),
    recent_activity: activity.map((a) => ({
      ref: toRef("activity", a.id),
      kind: a.kind,
      summary: a.summary,
      occurred_at: a.occurredAt.toISOString(),
      source_url: a.sourceUrl,
    })),
  };

  await recordReads(
    scope,
    [
      entity.ref,
      ...out.facts.map((x) => x.ref),
      ...out.decisions.map((x) => x.ref),
      ...tasks.map((x) => x.ref),
      ...out.people.map((x) => x.ref),
      ...out.projects.map((x) => x.ref),
      ...out.notes.map((x) => x.ref),
      ...out.recent_activity.map((x) => x.ref),
    ],
    { tool: "get_context", query: entity.name },
  );
  return out;
}

/* ---------- Calendar ---------- */

export interface CalendarOut {
  title: string;
  starts_at: string;
  ends_at: string;
  attendees: string[];
  personal: boolean;
  location: string | null;
  project: { ref: string; name: string } | null;
}

/**
 * Calendar events an AI may see: an event linked to a hidden project is left out, and so is one
 * whose linked people are all hidden (the same rule as tasks, question 9).
 */
export async function visibleCalendar(scope: AiScope, start: Date, end: Date): Promise<CalendarOut[]> {
  const g = scope.grants;
  const rows = await db
    .select()
    .from(calendarEventsTable)
    .where(
      and(
        gte(calendarEventsTable.startsAt, start),
        lt(calendarEventsTable.startsAt, end),
        sql`(${calendarEventsTable.projectId} is null or exists (select 1 from projects cp where cp.id = ${calendarEventsTable.projectId} and ${sql.raw(projectVisible("cp", g))}))`,
        sql`(${calendarEventsTable.projectId} is not null or cardinality(${calendarEventsTable.personIds}) = 0
          or exists (select 1 from people cpe where cpe.id = any(${calendarEventsTable.personIds}) and ${sql.raw(personVisible("cpe", g))}))`,
      ),
    )
    .orderBy(asc(calendarEventsTable.startsAt));
  const projectIds = [...new Set(rows.map((r) => r.projectId).filter((x): x is number => !!x))];
  const names = new Map(
    projectIds.length
      ? (await db.select({ id: projectsTable.id, name: projectsTable.name }).from(projectsTable).where(inArray(projectsTable.id, projectIds))).map((p) => [p.id, p.name])
      : [],
  );
  return rows.map((e) => ({
    title: e.title,
    starts_at: e.startsAt.toISOString(),
    ends_at: e.endsAt.toISOString(),
    attendees: e.attendees,
    personal: e.personal,
    location: e.location,
    project: e.projectId && names.has(e.projectId) ? { ref: toRef("project", e.projectId), name: names.get(e.projectId)! } : null,
  }));
}

/* ---------- Today (the ollieos://today resource) ---------- */

export interface TodayOut {
  date: string;
  last_sweep_at: string | null;
  inbox_count: number;
  do_next: TaskOut[];
  waiting_on: TaskOut[];
  promises: TaskOut[];
  done_this_week: number;
  calendar: CalendarOut[];
}

/** The Home summary, filtered for one AI client. */
export async function getToday(scope: AiScope): Promise<TodayOut> {
  const now = new Date();
  const today = todayLondon(now);
  const day = londonRange(today, 1);
  const notSnoozed = sql`(${tasksTable.snoozedUntil} is null or ${tasksTable.snoozedUntil} <= ${now.toISOString()})`;
  const [nowRows, waitingRows, promiseRows, inbox, lastSweep, calendar] = await Promise.all([
    visibleTaskRows(scope, and(eq(tasksTable.status, "now"), eq(tasksTable.kind, "task"), notSnoozed), { limit: 30 }),
    visibleTaskRows(scope, eq(tasksTable.status, "waiting"), { limit: 50, order: [asc(tasksTable.waitingSince)] }),
    visibleTaskRows(scope, and(eq(tasksTable.kind, "promise"), inArray(tasksTable.status, OPEN)), { limit: 50 }),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(tasksTable)
      .where(and(eq(tasksTable.status, "inbox"), sql.raw(`(${taskVisibleExpr(scope)})`))),
    db
      .select({ finishedAt: sweepRunsTable.finishedAt })
      .from(sweepRunsTable)
      .where(isNotNull(sweepRunsTable.finishedAt))
      .orderBy(desc(sweepRunsTable.finishedAt))
      .limit(1),
    visibleCalendar(scope, day.start, day.end),
  ]);
  const [doNext, waiting, promises] = await Promise.all([toTaskOuts(scope, nowRows), toTaskOuts(scope, waitingRows), toTaskOuts(scope, promiseRows)]);
  const doneThisWeek = await countDoneThisWeek(scope, today);
  await recordReads(scope, [...doNext, ...waiting, ...promises].map((t) => t.ref), { tool: "today" });
  return {
    date: today,
    last_sweep_at: iso(lastSweep[0]?.finishedAt),
    inbox_count: inbox[0]?.n ?? 0,
    do_next: doNext,
    waiting_on: waiting,
    promises,
    done_this_week: doneThisWeek,
    calendar,
  };
}

function taskVisibleExpr(scope: AiScope): string {
  return taskVisible("tasks", scope.grants);
}

async function countDoneThisWeek(scope: AiScope, today: string): Promise<number> {
  const week = londonRange(weekStartOf(today), 7);
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tasksTable)
    .where(
      and(
        eq(tasksTable.status, "done"),
        gte(tasksTable.completedAt, week.start),
        lt(tasksTable.completedAt, week.end),
        sql.raw(taskVisibleExpr(scope)),
      ),
    );
  return r?.n ?? 0;
}
