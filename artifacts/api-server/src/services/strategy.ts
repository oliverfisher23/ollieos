/**
 * Strategy and ideas (build plan Part H). Ollie names and orders his own strategy sections; ideas move
 * between New, Come back to, Taken forward and Dropped. Claude can add ideas (addIdeaFromAi) but never
 * edits or deletes anything here. Deleting keeps the row for a week so Undo can bring it back.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, lte, sql } from "drizzle-orm";
import {
  db,
  goalsTable,
  ideasTable,
  projectsTable,
  strategySectionsTable,
  tasksTable,
  type Idea,
  type IdeaSource,
  type IdeaStatus,
  type StrategySection,
} from "@workspace/db";
import { todayLondon, isIsoDate } from "@workspace/shared";
import { writeAudit } from "../lib/audit";
import { ideaVisible, strategyVisible } from "../lib/ai-data/visibility";
import { captureTask, type CaptureWriter } from "./aiWrites";
import { ACTOR, cleanText } from "./knowledge/common";
import { createProject } from "./knowledge/entities";
import { NotFoundError, ValidationError } from "./tasks";

const UNDO_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

type Named = { id: number; name: string };
type Project = { id: number; name: string; slug: string };

/* ---------- Views ---------- */

export interface SectionView {
  id: number;
  name: string;
  body: string;
  sortOrder: number;
  goals: Named[];
  projects: Project[];
  confidential: boolean;
  aiAccess: boolean;
  /** True when AI cannot read it: its own switches, or a hidden project it drives */
  hiddenFromAi: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface IdeaView {
  id: number;
  title: string;
  notes: string | null;
  status: IdeaStatus;
  comeBackOn: string | null;
  /** Come back to, and its day has arrived */
  due: boolean;
  goal: Named | null;
  project: Project | null;
  takenTask: { id: number; title: string } | null;
  takenProject: Project | null;
  confidential: boolean;
  aiAccess: boolean;
  hiddenFromAi: boolean;
  source: IdeaSource;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

async function lookups(goalIds: number[], projectIds: number[], taskIds: number[]) {
  const u = (xs: number[]) => [...new Set(xs)];
  const [goals, projects, tasks] = await Promise.all([
    goalIds.length ? db.select({ id: goalsTable.id, name: goalsTable.name }).from(goalsTable).where(inArray(goalsTable.id, u(goalIds))) : [],
    projectIds.length
      ? db.select({ id: projectsTable.id, name: projectsTable.name, slug: projectsTable.slug }).from(projectsTable).where(inArray(projectsTable.id, u(projectIds)))
      : [],
    taskIds.length ? db.select({ id: tasksTable.id, title: tasksTable.title }).from(tasksTable).where(inArray(tasksTable.id, u(taskIds))) : [],
  ]);
  return { goals: new Map(goals.map((g) => [g.id, g])), projects: new Map(projects.map((p) => [p.id, p])), tasks: new Map(tasks.map((t) => [t.id, t])) };
}

/** Ids among the given rows that an AI client could read, with no grants. */
async function aiVisibleIds(table: "strategy_sections" | "ideas", ids: number[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  // The alias must not clash with the ones the visibility checks use inside.
  const expr = table === "ideas" ? ideaVisible("row_in") : strategyVisible("row_in");
  const res = await db.execute(sql`select row_in.id from ${sql.raw(table)} row_in where row_in.id in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)}) and ${sql.raw(expr)}`);
  return new Set((res.rows as { id: number }[]).map((r) => Number(r.id)));
}

async function toSectionViews(rows: StrategySection[]): Promise<SectionView[]> {
  const [l, visible] = await Promise.all([lookups(rows.flatMap((r) => r.goalIds), rows.flatMap((r) => r.projectIds), []), aiVisibleIds("strategy_sections", rows.map((r) => r.id))]);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    body: r.body,
    sortOrder: r.sortOrder,
    goals: r.goalIds.map((id) => l.goals.get(id)).filter((x): x is Named => !!x),
    projects: r.projectIds.map((id) => l.projects.get(id)).filter((x): x is Project => !!x),
    confidential: r.confidential,
    aiAccess: r.aiAccess,
    hiddenFromAi: !visible.has(r.id),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

async function toIdeaViews(rows: Idea[], today = todayLondon()): Promise<IdeaView[]> {
  const nums = (xs: (number | null)[]) => xs.filter((x): x is number => x != null);
  const [l, visible] = await Promise.all([
    lookups(nums(rows.map((r) => r.goalId)), nums(rows.flatMap((r) => [r.projectId, r.takenProjectId])), nums(rows.map((r) => r.takenTaskId))),
    aiVisibleIds("ideas", rows.map((r) => r.id)),
  ]);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    notes: r.notes,
    status: r.status,
    comeBackOn: r.comeBackOn,
    due: r.status === "come_back" && r.comeBackOn != null && r.comeBackOn <= today,
    goal: r.goalId != null ? (l.goals.get(r.goalId) ?? null) : null,
    project: r.projectId != null ? (l.projects.get(r.projectId) ?? null) : null,
    takenTask: r.takenTaskId != null ? (l.tasks.get(r.takenTaskId) ?? null) : null,
    takenProject: r.takenProjectId != null ? (l.projects.get(r.takenProjectId) ?? null) : null,
    confidential: r.confidential,
    aiAccess: r.aiAccess,
    hiddenFromAi: !visible.has(r.id),
    source: r.source,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

/* ---------- Checks ---------- */

async function checkGoals(ids: number[]): Promise<number[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const found = await db.select({ id: goalsTable.id }).from(goalsTable).where(inArray(goalsTable.id, unique));
  if (found.length !== unique.length) throw new NotFoundError("That goal does not exist");
  return unique;
}

async function checkProjects(ids: number[]): Promise<number[]> {
  const unique = [...new Set(ids)];
  if (!unique.length) return [];
  const found = await db.select({ id: projectsTable.id }).from(projectsTable).where(inArray(projectsTable.id, unique));
  if (found.length !== unique.length) throw new NotFoundError("That project does not exist");
  return unique;
}

/** Rows deleted more than a week ago are gone for good. */
async function purgeDeleted(now = new Date()) {
  const cutoff = new Date(now.getTime() - UNDO_KEEP_MS);
  await db.delete(strategySectionsTable).where(and(isNotNull(strategySectionsTable.deletedAt), lt(strategySectionsTable.deletedAt, cutoff)));
  await db.delete(ideasTable).where(and(isNotNull(ideasTable.deletedAt), lt(ideasTable.deletedAt, cutoff)));
}

/* ---------- Strategy sections ---------- */

export async function listSections(): Promise<SectionView[]> {
  const rows = await db
    .select()
    .from(strategySectionsTable)
    .where(isNull(strategySectionsTable.deletedAt))
    .orderBy(asc(strategySectionsTable.sortOrder), asc(strategySectionsTable.id));
  return toSectionViews(rows);
}

async function loadSection(id: number): Promise<StrategySection> {
  const [row] = await db.select().from(strategySectionsTable).where(and(eq(strategySectionsTable.id, id), isNull(strategySectionsTable.deletedAt)));
  if (!row) throw new NotFoundError("That section does not exist");
  return row;
}

export interface SectionInput {
  name: string;
  body?: string;
  goalIds?: number[];
  projectIds?: number[];
  confidential?: boolean;
  aiAccess?: boolean;
}

export async function createSection(input: SectionInput): Promise<SectionView> {
  const name = cleanText(input.name);
  if (!name) throw new ValidationError("A section needs a name");
  const [goalIds, projectIds] = await Promise.all([checkGoals(input.goalIds ?? []), checkProjects(input.projectIds ?? [])]);
  const row = await db.transaction(async (tx) => {
    const [{ next }] = (await tx.execute(sql`select coalesce(max(sort_order), -1) + 1 as next from strategy_sections where deleted_at is null`)).rows as { next: number }[];
    const [created] = await tx
      .insert(strategySectionsTable)
      .values({
        name,
        body: input.body ?? "",
        sortOrder: Number(next),
        goalIds,
        projectIds,
        confidential: input.confidential ?? false,
        aiAccess: input.aiAccess ?? true,
      })
      .returning();
    await writeAudit(tx, { actor: ACTOR, action: "create", entityType: "strategy", entityId: created.id, payload: { name } });
    return created;
  });
  return (await toSectionViews([row]))[0];
}

export async function updateSection(id: number, input: Partial<SectionInput>): Promise<SectionView> {
  await loadSection(id);
  const set: Partial<typeof strategySectionsTable.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = cleanText(input.name);
    if (!name) throw new ValidationError("A section needs a name");
    set.name = name;
  }
  if (input.body !== undefined) set.body = input.body;
  if (input.goalIds !== undefined) set.goalIds = await checkGoals(input.goalIds);
  if (input.projectIds !== undefined) set.projectIds = await checkProjects(input.projectIds);
  if (input.confidential !== undefined) set.confidential = input.confidential;
  if (input.aiAccess !== undefined) set.aiAccess = input.aiAccess;
  if (!Object.keys(set).length) return (await toSectionViews([await loadSection(id)]))[0];
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx.update(strategySectionsTable).set({ ...set, updatedAt: new Date() }).where(eq(strategySectionsTable.id, id)).returning();
    await writeAudit(tx, { actor: ACTOR, action: "update", entityType: "strategy", entityId: id, payload: { fields: Object.keys(set) } });
    return updated;
  });
  return (await toSectionViews([row]))[0];
}

/** Puts the sections in the given order. Every current section must be listed once. */
export async function reorderSections(ids: number[]): Promise<SectionView[]> {
  const current = await db.select({ id: strategySectionsTable.id }).from(strategySectionsTable).where(isNull(strategySectionsTable.deletedAt));
  const want = new Set(current.map((c) => c.id));
  if (ids.length !== want.size || new Set(ids).size !== ids.length || ids.some((i) => !want.has(i))) {
    throw new ValidationError("List every section once to reorder them");
  }
  await db.transaction(async (tx) => {
    for (const [i, id] of ids.entries()) await tx.update(strategySectionsTable).set({ sortOrder: i }).where(eq(strategySectionsTable.id, id));
    await writeAudit(tx, { actor: ACTOR, action: "reorder", entityType: "strategy", payload: { ids } });
  });
  return listSections();
}

export async function deleteSection(id: number): Promise<void> {
  await loadSection(id);
  await db.transaction(async (tx) => {
    await tx.update(strategySectionsTable).set({ deletedAt: new Date() }).where(eq(strategySectionsTable.id, id));
    await writeAudit(tx, { actor: ACTOR, action: "delete", entityType: "strategy", entityId: id });
  });
  await purgeDeleted();
}

export async function restoreSection(id: number): Promise<SectionView> {
  const [row] = await db
    .update(strategySectionsTable)
    .set({ deletedAt: null })
    .where(and(eq(strategySectionsTable.id, id), isNotNull(strategySectionsTable.deletedAt)))
    .returning();
  if (!row) throw new NotFoundError("That section can no longer be brought back");
  await writeAudit(db, { actor: ACTOR, action: "restore", entityType: "strategy", entityId: id });
  return (await toSectionViews([row]))[0];
}

/* ---------- Ideas ---------- */

export const IDEA_TABS = ["new", "come_back", "taken_forward", "dropped"] as const;

export interface IdeaList {
  ideas: IdeaView[];
  counts: Record<IdeaStatus, number>;
  /** Come back to ideas whose day has arrived */
  due: number;
}

export async function listIdeas(params: { status?: IdeaStatus; q?: string }): Promise<IdeaList> {
  const today = todayLondon();
  const q = params.q?.trim();
  const where = [isNull(ideasTable.deletedAt)];
  if (params.status) where.push(eq(ideasTable.status, params.status));
  if (q) {
    const like = "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
    where.push(sql`(${ideasTable.title} ilike ${like} or ${ideasTable.notes} ilike ${like})`);
  }
  const order =
    params.status === "come_back" ? [asc(ideasTable.comeBackOn), desc(ideasTable.createdAt)] : [desc(params.status === "new" ? ideasTable.createdAt : ideasTable.updatedAt)];
  const [rows, counts] = await Promise.all([
    db.select().from(ideasTable).where(and(...where)).orderBy(...order).limit(300),
    db
      .select({ status: ideasTable.status, n: sql<number>`count(*)::int`, due: sql<number>`count(*) filter (where ${ideasTable.comeBackOn} <= ${today})::int` })
      .from(ideasTable)
      .where(isNull(ideasTable.deletedAt))
      .groupBy(ideasTable.status),
  ]);
  const byStatus = Object.fromEntries(IDEA_TABS.map((s) => [s, 0])) as Record<IdeaStatus, number>;
  let due = 0;
  for (const c of counts) {
    byStatus[c.status] = c.n;
    if (c.status === "come_back") due = c.due;
  }
  return { ideas: await toIdeaViews(rows, today), counts: byStatus, due };
}

/** Come back to ideas whose day has arrived, oldest date first: for Home and the digest. */
export async function dueIdeas(today = todayLondon()): Promise<IdeaView[]> {
  const rows = await db
    .select()
    .from(ideasTable)
    .where(and(isNull(ideasTable.deletedAt), eq(ideasTable.status, "come_back"), lte(ideasTable.comeBackOn, today)))
    .orderBy(asc(ideasTable.comeBackOn), asc(ideasTable.id));
  return toIdeaViews(rows, today);
}

async function loadIdea(id: number): Promise<Idea> {
  const [row] = await db.select().from(ideasTable).where(and(eq(ideasTable.id, id), isNull(ideasTable.deletedAt)));
  if (!row) throw new NotFoundError("That idea does not exist");
  return row;
}

export async function getIdea(id: number): Promise<IdeaView> {
  return (await toIdeaViews([await loadIdea(id)]))[0];
}

export interface IdeaInput {
  title: string;
  notes?: string | null;
  status?: "new" | "come_back" | "dropped";
  comeBackOn?: string | null;
  goalId?: number | null;
  projectId?: number | null;
  confidential?: boolean;
  aiAccess?: boolean;
}

function checkComeBack(status: IdeaStatus, comeBackOn: string | null | undefined) {
  if (comeBackOn != null && !isIsoDate(comeBackOn)) throw new ValidationError("Use a YYYY-MM-DD date");
  if (status === "come_back" && !comeBackOn) throw new ValidationError("Pick a day to come back to it");
}

async function insertIdea(input: IdeaInput, who: { actor: string; source: IdeaSource; clientId?: number | null; sessionId?: number | null }): Promise<Idea> {
  const title = cleanText(input.title);
  if (!title) throw new ValidationError("An idea needs a title");
  const status = input.status ?? "new";
  checkComeBack(status, input.comeBackOn);
  if (input.goalId != null) await checkGoals([input.goalId]);
  if (input.projectId != null) await checkProjects([input.projectId]);
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(ideasTable)
      .values({
        title,
        notes: cleanText(input.notes),
        status,
        comeBackOn: status === "come_back" ? input.comeBackOn! : null,
        goalId: input.goalId ?? null,
        projectId: input.projectId ?? null,
        confidential: input.confidential ?? false,
        aiAccess: input.aiAccess ?? true,
        source: who.source,
        clientId: who.clientId ?? null,
        sessionId: who.sessionId ?? null,
        createdBy: who.actor,
      })
      .returning();
    await writeAudit(tx, { actor: who.actor, clientId: who.clientId ?? null, action: "create", entityType: "idea", entityId: created.id, payload: { source: who.source, status } });
    return created;
  });
}

export async function createIdea(input: IdeaInput): Promise<IdeaView> {
  return (await toIdeaViews([await insertIdea(input, { actor: ACTOR, source: "ollie" })]))[0];
}

/**
 * add_idea: Claude's idea goes straight onto the list as New, marked as Claude's. It is not
 * knowledge, so it skips the Knowledge Inbox. Returns whether an AI could read it back.
 */
export async function addIdeaFromAi(
  writer: CaptureWriter,
  input: { title: string; notes?: string | null; goalId?: number | null; projectId?: number | null; confidential?: boolean; fromSession?: boolean },
): Promise<{ id: number; visible: boolean }> {
  const row = await insertIdea(
    { title: input.title, notes: input.notes, goalId: input.goalId, projectId: input.projectId, confidential: input.confidential },
    { actor: writer.actor, source: input.fromSession ? "session" : "claude", clientId: writer.clientId },
  );
  const visible = await aiVisibleIds("ideas", [row.id]);
  return { id: row.id, visible: visible.has(row.id) };
}

export type IdeaUpdate = Partial<IdeaInput>;

export async function updateIdea(id: number, input: IdeaUpdate): Promise<IdeaView> {
  const current = await loadIdea(id);
  const set: Partial<typeof ideasTable.$inferInsert> = {};
  if (input.title !== undefined) {
    const title = cleanText(input.title);
    if (!title) throw new ValidationError("An idea needs a title");
    set.title = title;
  }
  if (input.notes !== undefined) set.notes = cleanText(input.notes);
  if (input.goalId !== undefined) set.goalId = input.goalId == null ? null : (await checkGoals([input.goalId]))[0];
  if (input.projectId !== undefined) set.projectId = input.projectId == null ? null : (await checkProjects([input.projectId]))[0];
  if (input.confidential !== undefined) set.confidential = input.confidential;
  if (input.aiAccess !== undefined) set.aiAccess = input.aiAccess;
  if (input.status !== undefined || input.comeBackOn !== undefined) {
    const status: IdeaStatus = input.status ?? current.status;
    const comeBackOn = input.comeBackOn !== undefined ? input.comeBackOn : current.comeBackOn;
    checkComeBack(status, comeBackOn);
    set.status = status;
    set.comeBackOn = status === "come_back" ? comeBackOn : null;
  }
  if (!Object.keys(set).length) return getIdea(id);
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx.update(ideasTable).set({ ...set, updatedAt: new Date() }).where(eq(ideasTable.id, id)).returning();
    await writeAudit(tx, { actor: ACTOR, action: "update", entityType: "idea", entityId: id, payload: { fields: Object.keys(set), status: set.status ?? null } });
    return updated;
  });
  return (await toIdeaViews([row]))[0];
}

/**
 * Takes an idea forward as a task (in Backlog) or a project, in one step, and links the two.
 * The idea's goal and project carry over; its notes become the task's notes or the project's summary.
 */
export async function takeIdeaForward(id: number, as: "task" | "project"): Promise<IdeaView> {
  const idea = await loadIdea(id);
  if (idea.status === "taken_forward") throw new ValidationError("This idea has already been taken forward");
  let takenTaskId: number | null = null;
  let takenProjectId: number | null = null;
  if (as === "task") {
    const r = await captureTask(
      { actor: ACTOR, clientId: null },
      {
        title: idea.title,
        status: "backlog",
        source: "manual",
        notes: idea.notes,
        projectId: idea.projectId,
        confidential: idea.confidential || !idea.aiAccess ? true : null,
      },
      { applyNoise: false, via: "idea" },
    );
    takenTaskId = r.taskId;
    if (takenTaskId != null && idea.goalId != null && idea.projectId == null) {
      await db.update(tasksTable).set({ goalId: idea.goalId }).where(eq(tasksTable.id, takenTaskId));
    }
  } else {
    const p = await createProject({ name: idea.title, summary: idea.notes?.slice(0, 5000) ?? null, confidential: idea.confidential, aiAccess: idea.aiAccess });
    takenProjectId = p.id;
    if (idea.goalId != null) await db.update(projectsTable).set({ goalId: idea.goalId }).where(eq(projectsTable.id, p.id));
  }
  const row = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(ideasTable)
      .set({ status: "taken_forward", comeBackOn: null, takenTaskId, takenProjectId, updatedAt: new Date() })
      .where(eq(ideasTable.id, id))
      .returning();
    await writeAudit(tx, { actor: ACTOR, action: "take_forward", entityType: "idea", entityId: id, payload: { as, taskId: takenTaskId, projectId: takenProjectId } });
    return updated;
  });
  return (await toIdeaViews([row]))[0];
}

export async function deleteIdea(id: number): Promise<void> {
  await loadIdea(id);
  await db.transaction(async (tx) => {
    await tx.update(ideasTable).set({ deletedAt: new Date() }).where(eq(ideasTable.id, id));
    await writeAudit(tx, { actor: ACTOR, action: "delete", entityType: "idea", entityId: id });
  });
  await purgeDeleted();
}

export async function restoreIdea(id: number): Promise<IdeaView> {
  const [row] = await db.update(ideasTable).set({ deletedAt: null }).where(and(eq(ideasTable.id, id), isNotNull(ideasTable.deletedAt))).returning();
  if (!row) throw new NotFoundError("That idea can no longer be brought back");
  await writeAudit(db, { actor: ACTOR, action: "restore", entityType: "idea", entityId: id });
  return (await toIdeaViews([row]))[0];
}
