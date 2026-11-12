import { and, asc, desc, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import {
  db,
  goalsTable,
  linksTable,
  organisationsTable,
  peopleTable,
  projectsTable,
  tasksTable,
  type Organisation as OrgRow,
  type Person as PersonRow,
  type Project as ProjectRow,
} from "@workspace/db";
import { hasEmail } from "../personMatch";
import { domainsForOrganisation, researchViews, type ResearchView } from "../research";
import { BUSINESS_FUNCTION_LABELS, CADENCE_LABELS, OPEN_STATUSES, STRENGTH_WINDOW_DAYS, cleanTags, daysBetween, linkedinProfileUrl, londonDate, todayLondon, type Strength, isBusinessFunction, isClientOrgType, type BusinessFunction, type Cadence, type CadenceState, type ProjectLifecycle, type TaskStatus, type WorkType } from "@workspace/shared";
import { writeAudit } from "../../lib/audit";
import { ConflictError, NotFoundError, ValidationError } from "../tasks";
import { toTaskViews, type TaskView } from "../taskView";
import { ACTOR, cleanText, uniqueSlug, type EntitySummary } from "./common";
import { factsFor, linkedIds, listDecisions, notesFor, type DecisionView, type FactView, type NoteView } from "./items";
import { timelineFor, type TimelineItem } from "./timeline";
import { assertGoal } from "../goals";
import { listDocuments, rulesForProject, type DocumentView, type RuleView } from "../library";
import { cadenceFor, pausedByProjects, projectsForPeople, stateFor, strengthOf } from "../cadence";
import { contactDays } from "../cadenceSuggestions";
import { introductionsFor, type Introduction } from "../introductions";
import { playbooksFor, type PlaybookView } from "../playbooks";
import { productsLinkedTo, type LinkedSummary } from "../products";
import { clientNamesSql, workTypeSql, ensureFunctions, projectsInFunction, type FunctionProject } from "./functions";

const OPEN = [...OPEN_STATUSES] as TaskStatus[];
const priorityRank = sql`case ${tasksTable.priority} when 'high' then 0 when 'medium' then 1 else 2 end`;

function stripSearch<T extends { search?: unknown }>(row: T): Omit<T, "search"> {
  const { search: _s, ...rest } = row;
  return rest;
}

async function openTasksWhere(where: ReturnType<typeof and>): Promise<TaskView[]> {
  const rows = await db
    .select()
    .from(tasksTable)
    .where(and(where, inArray(tasksTable.status, OPEN)))
    .orderBy(priorityRank, sql`${tasksTable.dueDate} asc nulls last`, desc(tasksTable.createdAt));
  return toTaskViews(rows);
}

/* ---------- Projects ---------- */

export type ProjectView = Omit<ProjectRow, "search">;

export interface ProjectListItem extends EntitySummary {
  aiAccess: boolean;
  area: string | null;
  status: string | null;
  function: BusinessFunction | null;
  isFunction: boolean;
  clients: string[];
  /** Client work or internal: as set, or client when a client is linked; null when not sorted yet */
  workType: WorkType | null;
  openTaskCount: number;
  updatedAt: Date;
}

export async function listProjects(includeArchived = false): Promise<ProjectListItem[]> {
  await ensureFunctions();
  const counts = db
    .select({ projectId: tasksTable.projectId, n: sql<number>`count(*)::int`.as("n") })
    .from(tasksTable)
    .where(and(isNotNull(tasksTable.projectId), inArray(tasksTable.status, OPEN)))
    .groupBy(tasksTable.projectId)
    .as("c");
  const rows = await db
    .select({
      id: projectsTable.id,
      name: projectsTable.name,
      slug: projectsTable.slug,
      confidential: projectsTable.confidential,
      aiAccess: projectsTable.aiAccess,
      area: projectsTable.area,
      status: projectsTable.status,
      function: projectsTable.function,
      isFunction: projectsTable.isFunction,
      clients: clientNamesSql(projectsTable.id),
      workType: workTypeSql,
      updatedAt: projectsTable.updatedAt,
      openTaskCount: sql<number>`coalesce(${counts.n}, 0)`,
    })
    .from(projectsTable)
    .leftJoin(counts, eq(counts.projectId, projectsTable.id))
    .where(includeArchived ? undefined : eq(projectsTable.archived, false))
    .orderBy(asc(projectsTable.name));
  return rows.map((r) => ({ ...r, clients: r.clients ?? [], workType: r.workType ?? null, openTaskCount: Number(r.openTaskCount) }));
}

export interface PersonChip extends EntitySummary {
  role: string | null;
  organisationName: string | null;
  /** True when joined through a link Ollie can remove; false when it only comes from tasks */
  linked: boolean;
}

export interface LinkedEntity extends EntitySummary {
  linked: boolean;
}

export interface ProjectDetail {
  project: ProjectView;
  /** The linked goal or sub-goal, with its parent's name for a sub-goal */
  goal: { id: number; name: string; parentName: string | null } | null;
  documents: DocumentView[];
  rules: RuleView[];
  /** Playbooks linked to the project (Part M) */
  playbooks: PlaybookView[];
  /** Products linked to the project (Part M) */
  products: LinkedSummary[];
  facts: FactView[];
  decisions: DecisionView[];
  openTasks: TaskView[];
  people: PersonChip[];
  organisations: LinkedEntity[];
  /** Which of the organisations are clients: typed customer, client or partner */
  clientIds: number[];
  /** On a function: the projects in it */
  functionProjects: FunctionProject[];
  notes: NoteView[];
  activity: TimelineItem[];
}

async function personChips(ids: number[], linkedSet: Set<number>): Promise<PersonChip[]> {
  if (!ids.length) return [];
  const rows = await db
    .select({
      id: peopleTable.id,
      name: peopleTable.name,
      slug: peopleTable.slug,
      confidential: peopleTable.confidential,
      role: peopleTable.role,
      organisationName: organisationsTable.name,
    })
    .from(peopleTable)
    .leftJoin(organisationsTable, eq(organisationsTable.id, peopleTable.organisationId))
    .where(inArray(peopleTable.id, ids))
    .orderBy(asc(peopleTable.name));
  return rows.map((r) => ({ ...r, linked: linkedSet.has(r.id) }));
}

async function summaries(table: typeof projectsTable | typeof organisationsTable, ids: number[], linkedSet: Set<number>): Promise<LinkedEntity[]> {
  if (!ids.length) return [];
  const rows = await db
    .select({ id: table.id, name: table.name, slug: table.slug, confidential: table.confidential })
    .from(table)
    .where(inArray(table.id, ids))
    .orderBy(asc(table.name));
  return rows.map((r) => ({ ...r, linked: linkedSet.has(r.id) }));
}

async function loadProject(slug: string): Promise<ProjectRow> {
  const [row] = await db.select().from(projectsTable).where(eq(projectsTable.slug, slug));
  if (!row) throw new NotFoundError("That project does not exist");
  return row;
}

export async function getProject(slug: string): Promise<ProjectDetail> {
  const project = await loadProject(slug);
  const id = project.id;
  const [facts, decisions, openTasks, linkedPeople, linkedOrgs, notes, taskPeople, goal, documents, rules, playbooks, products] = await Promise.all([
    factsFor("project", id),
    listDecisions(id),
    openTasksWhere(eq(tasksTable.projectId, id)),
    linkedIds("project", id, "person"),
    linkedIds("project", id, "organisation"),
    notesFor("project", id),
    db
      .selectDistinct({ id: tasksTable.personId })
      .from(tasksTable)
      .where(and(eq(tasksTable.projectId, id), isNotNull(tasksTable.personId), ne(tasksTable.status, "noise"))),
    projectGoal(project.goalId),
    listDocuments(id),
    rulesForProject(id),
    playbooksFor("project", id),
    productsLinkedTo("project", id),
  ]);
  const peopleIds = [...new Set([...linkedPeople, ...taskPeople.map((p) => p.id!)])];
  const [people, organisations, activity, orgTypes, functionProjects] = await Promise.all([
    personChips(peopleIds, new Set(linkedPeople)),
    summaries(organisationsTable, linkedOrgs, new Set(linkedOrgs)),
    timelineFor("project", id, notes),
    linkedOrgs.length
      ? db.select({ id: organisationsTable.id, type: organisationsTable.type }).from(organisationsTable).where(inArray(organisationsTable.id, linkedOrgs))
      : Promise.resolve([] as { id: number; type: string | null }[]),
    project.isFunction && project.function ? projectsInFunction(project.function) : Promise.resolve([] as FunctionProject[]),
  ]);
  const clientIds = orgTypes.filter((o) => isClientOrgType(o.type)).map((o) => o.id);
  return { project: stripSearch(project), goal, documents, rules, playbooks, products, facts, decisions, openTasks, people, organisations, clientIds, functionProjects, notes, activity };
}

async function projectGoal(goalId: number | null): Promise<ProjectDetail["goal"]> {
  if (!goalId) return null;
  const [g] = await db
    .select({ id: goalsTable.id, name: goalsTable.name, parentName: sql<string | null>`(select p.name from goals p where p.id = ${goalsTable.parentId})` })
    .from(goalsTable)
    .where(eq(goalsTable.id, goalId));
  return g ?? null;
}

export interface ProjectInput {
  name: string;
  area?: string | null;
  status?: string | null;
  summary?: string | null;
  function?: BusinessFunction | null;
  confidential?: boolean;
  aiAccess?: boolean;
}

function checkFunction(fn: unknown): BusinessFunction | null {
  if (fn == null) return null;
  if (!isBusinessFunction(fn)) throw new ValidationError("Choose a function from the list");
  return fn;
}

export async function createProject(input: ProjectInput): Promise<ProjectView> {
  const name = cleanText(input.name);
  if (!name) throw new ValidationError("A project needs a name");
  const row = await db.transaction(async (tx) => {
    const slug = await uniqueSlug(tx, "project", name);
    const [created] = await tx
      .insert(projectsTable)
      .values({
        name,
        slug,
        area: cleanText(input.area),
        status: cleanText(input.status),
        summary: cleanText(input.summary),
        function: checkFunction(input.function),
        confidential: input.confidential ?? false,
        aiAccess: input.aiAccess ?? true,
      })
      .returning();
    await writeAudit(tx, { actor: ACTOR, action: "create", entityType: "project", entityId: created.id, payload: { name } });
    return created;
  });
  return stripSearch(row);
}

export type ProjectUpdate = Partial<ProjectInput> & { archived?: boolean; goalId?: number | null; lifecycle?: ProjectLifecycle; workType?: WorkType | null };

export async function updateProject(slug: string, input: ProjectUpdate): Promise<ProjectView> {
  const current = await loadProject(slug);
  const set: Partial<ProjectRow> = {};
  if (current.isFunction) {
    // A function's name, function and place are fixed; everything else edits as on a project.
    const fixedName = input.name !== undefined && cleanText(input.name) !== current.name;
    const fixedFn = input.function !== undefined && input.function !== current.function;
    if (fixedName || fixedFn || input.archived === true) {
      throw new ValidationError(`${BUSINESS_FUNCTION_LABELS[current.function!]} is a function, so it cannot be renamed, moved or archived`);
    }
  }
  if (input.name !== undefined) {
    const name = cleanText(input.name);
    if (!name) throw new ValidationError("A project needs a name");
    set.name = name;
  }
  if (input.function !== undefined && !current.isFunction) set.function = checkFunction(input.function);
  if (input.area !== undefined) set.area = cleanText(input.area);
  if (input.status !== undefined) set.status = cleanText(input.status);
  if (input.summary !== undefined) set.summary = cleanText(input.summary);
  if (input.confidential !== undefined) set.confidential = input.confidential;
  if (input.aiAccess !== undefined) set.aiAccess = input.aiAccess;
  if (input.archived !== undefined) set.archived = input.archived;
  if (input.goalId !== undefined && input.goalId !== current.goalId) {
    await assertGoal(input.goalId);
    set.goalId = input.goalId;
  }
  if (input.lifecycle !== undefined && input.lifecycle !== current.lifecycle) set.lifecycle = input.lifecycle;
  if (input.workType !== undefined && input.workType !== current.workType) set.workType = input.workType;
  if (!Object.keys(set).length) return stripSearch(current);
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx.update(projectsTable).set(set).where(eq(projectsTable.id, current.id)).returning();
    await writeAudit(tx, {
      actor: ACTOR,
      action: "update",
      entityType: "project",
      entityId: current.id,
      payload: {
        fields: Object.keys(set),
        ...accessChange(current, set),
        ...(set.goalId !== undefined ? { goal: { from: current.goalId, to: set.goalId } } : {}),
        ...(set.lifecycle !== undefined ? { lifecycle: { from: current.lifecycle, to: set.lifecycle } } : {}),
      },
    });
    return updated;
  });
  return stripSearch(row);
}

/** Access switches are recorded with before and after, so the audit shows exactly when something was hidden. */
function accessChange(current: { confidential: boolean; aiAccess: boolean }, set: { confidential?: boolean; aiAccess?: boolean }) {
  const out: Record<string, unknown> = {};
  if (set.confidential !== undefined && set.confidential !== current.confidential) out.confidential = { from: current.confidential, to: set.confidential };
  if (set.aiAccess !== undefined && set.aiAccess !== current.aiAccess) out.aiAccess = { from: current.aiAccess, to: set.aiAccess };
  return out;
}

/* ---------- People ---------- */

export interface PersonListItem extends EntitySummary {
  aiAccess: boolean;
  role: string | null;
  organisation: EntitySummary | null;
  /** The organisation's type ("client", "partner"…), for the Contacts filters */
  organisationType: string | null;
  /** They work at Ollie's own company */
  internal: boolean;
  /** Ollie's own record */
  isSelf: boolean;
  lastContactAt: Date | null;
  iOweCount: number;
  theyOweCount: number;
  /** Their check-in cadence and where they stand against it, as on the person page */
  cadence: PersonCadence;
  /** Section 25: when the contact finder added them by itself, so Contacts can offer Undo */
  autoAddedAt: Date | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  slackUserId: string | null;
  tags: string[];
  /** Moved out of the main list */
  archived: boolean;
  /** Strong, warm, cooling or cold, from how often and how recently Ollie is in touch */
  strength: Strength;
  /** Not spoken to in a year, no cadence, no active project and nothing open: worth archiving */
  archiveCandidate: boolean;
}

/** Days without contact before someone is worth archiving; with no contact on file, the record's age counts instead. */
export const ARCHIVE_AFTER_DAYS = 365;
const ARCHIVE_NO_CONTACT_DAYS = 90;
const DAY_MS = 86_400_000;

/** Distinct days in touch in the strength window, per person. */
async function contactDayCounts(now = new Date()): Promise<Map<number, number>> {
  const days = await contactDays(new Date(now.getTime() - STRENGTH_WINDOW_DAYS * DAY_MS), now);
  return new Map([...days].map(([id, d]) => [id, d.length]));
}

export async function listPeople(): Promise<PersonListItem[]> {
  const [rows, owe] = await Promise.all([
    db
      .select({
        id: peopleTable.id,
        name: peopleTable.name,
        slug: peopleTable.slug,
        confidential: peopleTable.confidential,
        aiAccess: peopleTable.aiAccess,
        role: peopleTable.role,
        lastContactAt: peopleTable.lastContactAt,
        orgId: organisationsTable.id,
        orgName: organisationsTable.name,
        orgSlug: organisationsTable.slug,
        orgConfidential: organisationsTable.confidential,
        orgType: organisationsTable.type,
        orgInternal: organisationsTable.internal,
        isSelf: peopleTable.isSelf,
        cadence: peopleTable.cadence,
        cadencePaused: peopleTable.cadencePaused,
        autoAddedAt: peopleTable.autoAddedAt,
        email: peopleTable.email,
        phone: peopleTable.phone,
        linkedinUrl: peopleTable.linkedinUrl,
        slackUserId: peopleTable.slackUserId,
        tags: peopleTable.tags,
        archived: peopleTable.archived,
        createdAt: peopleTable.createdAt,
      })
      .from(peopleTable)
      .leftJoin(organisationsTable, eq(organisationsTable.id, peopleTable.organisationId))
      .orderBy(asc(peopleTable.name)),
    db
      .select({ personId: tasksTable.personId, waitingOn: tasksTable.waitingOnPersonId, status: tasksTable.status })
      .from(tasksTable)
      .where(and(inArray(tasksTable.status, OPEN), or(isNotNull(tasksTable.personId), isNotNull(tasksTable.waitingOnPersonId)))),
  ]);
  const iOwe = new Map<number, number>();
  const theyOwe = new Map<number, number>();
  for (const t of owe) {
    if (t.status === "waiting" && t.waitingOn) theyOwe.set(t.waitingOn, (theyOwe.get(t.waitingOn) ?? 0) + 1);
    else if (t.status !== "waiting" && t.personId) iOwe.set(t.personId, (iOwe.get(t.personId) ?? 0) + 1);
  }
  const ids = rows.map((r) => r.id);
  const now = new Date();
  const today = todayLondon();
  const [last, projects, dayCounts] = await Promise.all([lastContactFor(ids), projectsForPeople(ids), contactDayCounts(now)]);
  return rows.map((r) => {
    const lastContactAt = r.lastContactAt ?? last.get(r.id) ?? null;
    const iOweCount = iOwe.get(r.id) ?? 0;
    const theyOweCount = theyOwe.get(r.id) ?? 0;
    const quietDays = lastContactAt ? daysBetween(londonDate(lastContactAt), today) : null;
    const archiveCandidate =
      !r.isSelf &&
      !r.archived &&
      !r.orgInternal &&
      r.cadence === "none" &&
      !iOweCount &&
      !theyOweCount &&
      !(projects.get(r.id) ?? []).some((p) => p.lifecycle === "active") &&
      (quietDays != null ? quietDays > ARCHIVE_AFTER_DAYS : now.getTime() - r.createdAt.getTime() > ARCHIVE_NO_CONTACT_DAYS * DAY_MS);
    return {
    id: r.id,
    name: r.name,
    slug: r.slug,
    confidential: r.confidential,
    aiAccess: r.aiAccess,
    role: r.role,
    organisation: r.orgId ? { id: r.orgId, name: r.orgName!, slug: r.orgSlug!, confidential: r.orgConfidential! } : null,
    organisationType: r.orgType ?? null,
    internal: !!r.orgInternal,
    isSelf: r.isSelf,
    lastContactAt,
    iOweCount,
    theyOweCount,
    // Same state as the cadence page and person page: from the recorded last contact only.
    cadence: {
      ...stateFor(r, projects.get(r.id)),
      cadence: r.cadence,
      cadenceLabel: CADENCE_LABELS[r.cadence],
      cadencePaused: r.cadencePaused,
      pausedByProjects: !r.cadencePaused && pausedByProjects(projects.get(r.id)),
    },
    autoAddedAt: r.autoAddedAt ?? null,
    email: r.email,
    phone: r.phone,
    linkedinUrl: r.linkedinUrl,
    slackUserId: r.slackUserId,
    tags: r.tags,
    archived: r.archived,
    strength: strengthOf(lastContactAt, dayCounts.get(r.id) ?? 0, today),
    archiveCandidate,
    };
  });
}

/** Until the sweep records contact directly, the latest captured email, Slack or meeting item linked to the person. */
async function lastContactFor(ids: number[]): Promise<Map<number, Date>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ personId: tasksTable.personId, at: sql<string>`max(coalesce(${tasksTable.capturedAt}, ${tasksTable.createdAt}))` })
    .from(tasksTable)
    .where(and(inArray(tasksTable.personId, ids), ne(tasksTable.source, "manual")))
    .groupBy(tasksTable.personId);
  return new Map(rows.map((r) => [r.personId!, new Date(r.at)]));
}

export type PersonView = Omit<PersonRow, "search" | "organisationId"> & { organisation: EntitySummary | null };

export type PersonCadence = CadenceState & { cadence: Cadence; cadenceLabel: string; cadencePaused: boolean; pausedByProjects: boolean };

export interface PersonDetail {
  person: PersonView;
  /** Strong, warm, cooling or cold, as on Contacts */
  strength: Strength;
  /** People Ollie knows well who could introduce him; empty when he already knows this person well */
  introductions: Introduction[];
  cadence: PersonCadence;
  iOwe: TaskView[];
  theyOwe: TaskView[];
  projects: LinkedEntity[];
  facts: FactView[];
  notes: NoteView[];
  timeline: TimelineItem[];
}

async function loadPerson(slug: string): Promise<PersonRow> {
  const [row] = await db.select().from(peopleTable).where(eq(peopleTable.slug, slug));
  if (!row) throw new NotFoundError("That person does not exist");
  return row;
}

async function toPersonView(row: PersonRow): Promise<PersonView> {
  const { search: _s, organisationId, ...rest } = row;
  let organisation: EntitySummary | null = null;
  if (organisationId) {
    const [o] = await db
      .select({ id: organisationsTable.id, name: organisationsTable.name, slug: organisationsTable.slug, confidential: organisationsTable.confidential })
      .from(organisationsTable)
      .where(eq(organisationsTable.id, organisationId));
    organisation = o ?? null;
  }
  const last = rest.lastContactAt ?? (await lastContactFor([row.id])).get(row.id) ?? null;
  return { ...rest, lastContactAt: last, organisation };
}

export async function getPerson(slug: string): Promise<PersonDetail> {
  const row = await loadPerson(slug);
  const id = row.id;
  const [person, iOwe, theyOwe, linkedProjects, taskProjects, facts, notes, cadence] = await Promise.all([
    toPersonView(row),
    openTasksWhere(and(eq(tasksTable.personId, id), ne(tasksTable.status, "waiting"))),
    openTasksWhere(and(eq(tasksTable.waitingOnPersonId, id), eq(tasksTable.status, "waiting"))),
    linkedIds("person", id, "project"),
    db
      .selectDistinct({ id: tasksTable.projectId })
      .from(tasksTable)
      .where(and(or(eq(tasksTable.personId, id), eq(tasksTable.waitingOnPersonId, id)), isNotNull(tasksTable.projectId), ne(tasksTable.status, "noise"))),
    factsFor("person", id),
    notesFor("person", id),
    cadenceFor(row),
  ]);
  const projectIds = [...new Set([...linkedProjects, ...taskProjects.map((p) => p.id!)])];
  const [projects, timeline, dayCounts] = await Promise.all([summaries(projectsTable, projectIds, new Set(linkedProjects)), timelineFor("person", id, notes), contactDayCounts()]);
  const strength = strengthOf(person.lastContactAt, dayCounts.get(id) ?? 0);
  const introductions = row.isSelf ? [] : await introductionsFor(row, strength, dayCounts);
  return { person, strength, introductions, cadence, iOwe, theyOwe, projects, facts, notes, timeline };
}

export interface PersonInput {
  name: string;
  organisationId?: number | null;
  role?: string | null;
  email?: string | null;
  relationshipSummary?: string | null;
  confidential?: boolean;
  aiAccess?: boolean;
  phone?: string | null;
  tags?: string[];
}

export type PersonUpdate = Partial<PersonInput> & {
  /** Out of the main Contacts list; archiving clears the cadence */
  archived?: boolean;
  cadence?: Cadence;
  cadencePaused?: boolean;
  /** Part N: the person's other addresses, replacing the list */
  otherEmails?: string[];
  /** Part N: their Slack user id, or null to unlink */
  slackUserId?: string | null;
  /** Section 28: other names they go by, replacing the list */
  otherNames?: string[];
  /** Their LinkedIn profile link, or null to clear it */
  linkedinUrl?: string | null;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Cleans a list of other addresses: lower case, no repeats, not the main one, and not anyone else's. */
async function cleanOtherEmails(list: string[], main: string | null, exceptId: number): Promise<string[]> {
  const out: string[] = [];
  for (const raw of list) {
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL_RE.test(e)) throw new ValidationError(`${raw.trim()} is not an email address`);
    if (e === main || out.includes(e)) continue;
    await assertEmailFree(e, exceptId);
    out.push(e);
  }
  if (out.length > 20) throw new ValidationError("Keep it to 20 other addresses");
  return out;
}

async function assertSlackFree(id: string, exceptId: number) {
  const [p] = await db.select({ id: peopleTable.id, name: peopleTable.name }).from(peopleTable).where(eq(peopleTable.slackUserId, id));
  if (p && p.id !== exceptId) throw new ConflictError(`${p.name} already has that Slack account`);
}

async function assertOrg(id: number | null | undefined) {
  if (!id) return;
  const [o] = await db.select({ id: organisationsTable.id }).from(organisationsTable).where(eq(organisationsTable.id, id));
  if (!o) throw new NotFoundError("That organisation does not exist");
}

/** The organisation Ollie has given this address's email domain to, if any. */
export async function organisationForEmail(email: string | null | undefined): Promise<number | null> {
  const domain = email?.toLowerCase().split("@")[1];
  if (!domain) return null;
  const [o] = await db.select({ id: organisationsTable.id }).from(organisationsTable).where(sql`${domain} = any(${organisationsTable.domains})`).limit(1);
  return o?.id ?? null;
}

async function assertEmailFree(email: string | null, exceptId?: number) {
  if (!email) return;
  const [p] = await db.select({ id: peopleTable.id, name: peopleTable.name }).from(peopleTable).where(hasEmail(email));
  if (p && p.id !== exceptId) throw new ConflictError(`${p.name} already has that email address`);
}

export async function createPerson(input: PersonInput): Promise<PersonView> {
  const name = cleanText(input.name);
  if (!name) throw new ValidationError("A person needs a name");
  const email = cleanText(input.email)?.toLowerCase() ?? null;
  await Promise.all([assertOrg(input.organisationId), assertEmailFree(email)]);
  // No organisation given: the one whose email domain they write from, when Ollie has set one.
  const organisationId = input.organisationId ?? (await organisationForEmail(email));
  const row = await db.transaction(async (tx) => {
    const slug = await uniqueSlug(tx, "person", name);
    const [created] = await tx
      .insert(peopleTable)
      .values({
        name,
        slug,
        organisationId,
        phone: cleanText(input.phone),
        tags: cleanTags(input.tags ?? []),
        role: cleanText(input.role),
        email,
        relationshipSummary: cleanText(input.relationshipSummary),
        confidential: input.confidential ?? false,
        aiAccess: input.aiAccess ?? true,
      })
      .returning();
    await writeAudit(tx, { actor: ACTOR, action: "create", entityType: "person", entityId: created.id, payload: { name } });
    return created;
  });
  return toPersonView(row);
}

export async function updatePerson(slug: string, input: PersonUpdate): Promise<PersonView> {
  const current = await loadPerson(slug);
  const set: Partial<PersonRow> = {};
  if (input.name !== undefined) {
    const name = cleanText(input.name);
    if (!name) throw new ValidationError("A person needs a name");
    set.name = name;
  }
  if (input.organisationId !== undefined) {
    await assertOrg(input.organisationId);
    set.organisationId = input.organisationId;
  }
  if (input.role !== undefined) set.role = cleanText(input.role);
  if (input.email !== undefined) {
    const email = cleanText(input.email)?.toLowerCase() ?? null;
    await assertEmailFree(email, current.id);
    set.email = email;
  }
  if (input.otherEmails !== undefined) {
    set.otherEmails = await cleanOtherEmails(input.otherEmails, set.email !== undefined ? set.email : (current.email?.toLowerCase() ?? null), current.id);
  } else if (set.email && current.otherEmails.includes(set.email)) {
    // Making one of the other addresses the main one takes it off the other list.
    set.otherEmails = current.otherEmails.filter((e) => e !== set.email);
  }
  if (input.otherNames !== undefined) {
    const main = (set.name ?? current.name).trim().toLowerCase();
    const seen = new Set<string>();
    set.otherNames = input.otherNames
      .map((n) => n.replace(/\s+/g, " ").trim().slice(0, 100))
      .filter((n) => n && n.toLowerCase() !== main && !seen.has(n.toLowerCase()) && !!seen.add(n.toLowerCase()))
      .slice(0, 10);
  }
  if (input.slackUserId !== undefined) {
    const id = cleanText(input.slackUserId);
    if (id) await assertSlackFree(id, current.id);
    set.slackUserId = id;
  }
  if (input.relationshipSummary !== undefined) set.relationshipSummary = cleanText(input.relationshipSummary);
  if (input.linkedinUrl !== undefined) {
    const raw = cleanText(input.linkedinUrl);
    const url = raw ? linkedinProfileUrl(raw) : null;
    if (raw && !url) throw new ValidationError("That does not look like a LinkedIn profile link (linkedin.com/in/…)");
    set.linkedinUrl = url;
  }
  if (input.phone !== undefined) set.phone = cleanText(input.phone);
  if (input.tags !== undefined) set.tags = cleanTags(input.tags);
  if (input.archived !== undefined && input.archived !== current.archived) {
    if (current.isSelf && input.archived) throw new ValidationError("Your own record cannot be archived");
    set.archived = input.archived;
    // Out of the list means out of check-ins too.
    if (input.archived) set.cadence = "none";
  }
  if (input.confidential !== undefined) set.confidential = input.confidential;
  if (input.aiAccess !== undefined) set.aiAccess = input.aiAccess;
  if (input.cadence !== undefined && input.cadence !== current.cadence && !set.archived) {
    if (current.isSelf && input.cadence !== "none") throw new ValidationError("Your own record has no cadence");
    set.cadence = input.cadence;
  }
  if (input.cadencePaused !== undefined && input.cadencePaused !== current.cadencePaused) set.cadencePaused = input.cadencePaused;
  if (!Object.keys(set).length) return toPersonView(current);
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx.update(peopleTable).set(set).where(eq(peopleTable.id, current.id)).returning();
    await writeAudit(tx, {
      actor: ACTOR,
      action: "update",
      entityType: "person",
      entityId: current.id,
      payload: { fields: Object.keys(set), ...accessChange(current, set) },
    });
    return updated;
  });
  return toPersonView(row);
}

/* ---------- Organisations ---------- */

export type OrganisationView = Omit<OrgRow, "search">;

export interface OrganisationListItem extends EntitySummary {
  aiAccess: boolean;
  type: string | null;
  internal: boolean;
  peopleCount: number;
  /** The latest contact with anyone who works there */
  lastContactAt: Date | null;
}

export async function listOrganisations(): Promise<OrganisationListItem[]> {
  const rows = await db
    .select({
      id: organisationsTable.id,
      name: organisationsTable.name,
      slug: organisationsTable.slug,
      confidential: organisationsTable.confidential,
      aiAccess: organisationsTable.aiAccess,
      type: organisationsTable.type,
      internal: organisationsTable.internal,
      peopleCount: sql<number>`(select count(*)::int from people p where p.organisation_id = organisations.id)`,
      lastContactAt: sql<string | null>`(select max(p.last_contact_at) from people p where p.organisation_id = organisations.id and not p.is_self)`,
    })
    .from(organisationsTable)
    // External organisations first, then Ollie's own company.
    .orderBy(asc(organisationsTable.internal), asc(organisationsTable.name));
  return rows.map((r) => ({ ...r, peopleCount: Number(r.peopleCount), lastContactAt: r.lastContactAt ? new Date(r.lastContactAt) : null }));
}

export interface OrganisationDetail {
  organisation: OrganisationView;
  people: PersonChip[];
  projects: LinkedEntity[];
  /** Playbooks and products linked to the organisation (Part M) */
  playbooks: PlaybookView[];
  products: LinkedSummary[];
  facts: FactView[];
  notes: NoteView[];
  timeline: TimelineItem[];
  /** What the research agent found, by the email domains of the organisation's people; none for your own company */
  research: ResearchView[];
  /** Who reports to whom among the people who work here, for the org chart */
  reportsTo: { personId: number; managerId: number }[];
}

async function loadOrg(slug: string): Promise<OrgRow> {
  const [row] = await db.select().from(organisationsTable).where(eq(organisationsTable.slug, slug));
  if (!row) throw new NotFoundError("That organisation does not exist");
  return row;
}

export async function getOrganisation(slug: string): Promise<OrganisationDetail> {
  const org = await loadOrg(slug);
  const id = org.id;
  const [members, linkedPeople, linkedProjects, facts, notes, playbooks, products] = await Promise.all([
    db.select({ id: peopleTable.id }).from(peopleTable).where(eq(peopleTable.organisationId, id)),
    linkedIds("organisation", id, "person"),
    linkedIds("organisation", id, "project"),
    factsFor("organisation", id),
    notesFor("organisation", id),
    playbooksFor("organisation", id),
    productsLinkedTo("organisation", id),
  ]);
  const memberIds = members.map((m) => m.id);
  const [people, projects, timeline, research, reports] = await Promise.all([
    personChips([...new Set([...memberIds, ...linkedPeople])], new Set(linkedPeople)),
    summaries(projectsTable, linkedProjects, new Set(linkedProjects)),
    timelineFor("organisation", id, notes, memberIds),
    org.internal ? [] : domainsForOrganisation(id).then((d) => researchViews(d.slice(0, 3))),
    memberIds.length
      ? db
          .select({ personId: linksTable.fromId, managerId: linksTable.toId })
          .from(linksTable)
          .where(and(eq(linksTable.relationship, "reports_to"), eq(linksTable.fromType, "person"), eq(linksTable.toType, "person"), inArray(linksTable.fromId, memberIds), inArray(linksTable.toId, memberIds)))
      : [],
  ]);
  return { organisation: stripSearch(org), people, projects, playbooks, products, facts, notes, timeline, research, reportsTo: reports };
}

export interface OrganisationInput {
  name: string;
  type?: string | null;
  internal?: boolean;
  summary?: string | null;
  confidential?: boolean;
  aiAccess?: boolean;
}

export async function createOrganisation(input: OrganisationInput): Promise<OrganisationView> {
  const name = cleanText(input.name);
  if (!name) throw new ValidationError("An organisation needs a name");
  const row = await db.transaction(async (tx) => {
    const slug = await uniqueSlug(tx, "organisation", name);
    const [created] = await tx
      .insert(organisationsTable)
      .values({
        name,
        slug,
        type: cleanText(input.type),
        internal: input.internal ?? false,
        summary: cleanText(input.summary),
        confidential: input.confidential ?? false,
        aiAccess: input.aiAccess ?? true,
      })
      .returning();
    await writeAudit(tx, { actor: ACTOR, action: "create", entityType: "organisation", entityId: created.id, payload: { name } });
    return created;
  });
  return stripSearch(row);
}

export async function updateOrganisation(slug: string, input: Partial<OrganisationInput>): Promise<OrganisationView> {
  const current = await loadOrg(slug);
  const set: Partial<OrgRow> = {};
  if (input.name !== undefined) {
    const name = cleanText(input.name);
    if (!name) throw new ValidationError("An organisation needs a name");
    set.name = name;
  }
  if (input.type !== undefined) set.type = cleanText(input.type);
  if (input.internal !== undefined && input.internal !== current.internal) set.internal = input.internal;
  if (input.summary !== undefined) set.summary = cleanText(input.summary);
  if (input.confidential !== undefined) set.confidential = input.confidential;
  if (input.aiAccess !== undefined) set.aiAccess = input.aiAccess;
  if (!Object.keys(set).length) return stripSearch(current);
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx.update(organisationsTable).set(set).where(eq(organisationsTable.id, current.id)).returning();
    await writeAudit(tx, {
      actor: ACTOR,
      action: "update",
      entityType: "organisation",
      entityId: current.id,
      payload: { fields: Object.keys(set), ...accessChange(current, set) },
    });
    return updated;
  });
  return stripSearch(row);
}
