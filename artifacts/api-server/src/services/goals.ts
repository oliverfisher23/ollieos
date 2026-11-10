/**
 * Goals (feature 04). Projects link to a goal or a sub-goal; a task inherits its project's goal
 * unless it sets its own. Counts on a sub-goal roll up to its parent.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, goalsTable, projectsTable, tasksTable, type Goal } from "@workspace/db";
import { OPEN_STATUSES, addDays, todayLondon, weekStartOf } from "@workspace/shared";
import { writeAudit } from "../lib/audit";
import { ACTOR, cleanText } from "./knowledge/common";
import { NotFoundError, ValidationError } from "./tasks";
import { ensureSeeds } from "./seeds";

const OPEN = [...OPEN_STATUSES];

/** The goal a task counts towards: its own, else its project's. */
export const effectiveGoalSql = sql<number | null>`coalesce(${tasksTable.goalId}, (select p.goal_id from projects p where p.id = ${tasksTable.projectId}))`;

/** Monday and Sunday of the current London week. */
export function thisWeek(today = todayLondon()): { start: string; end: string } {
  const start = weekStartOf(today);
  return { start, end: addDays(start, 6) };
}

export interface GoalSummary {
  id: number;
  name: string;
  parentId: number | null;
}

export interface GoalView extends Omit<Goal, "createdAt" | "updatedAt"> {
  number: number;
  subGoals: (Omit<Goal, "createdAt" | "updatedAt"> & { projects: { id: number; name: string; slug: string }[] })[];
  projects: { id: number; name: string; slug: string; goalId: number }[];
  openTasks: number;
  dueThisWeek: number;
}

export interface UnlinkedTask {
  id: number;
  title: string;
  status: string;
  dueDate: string | null;
  project: { id: number; name: string; slug: string } | null;
}

export interface GoalsPage {
  goals: GoalView[];
  /** N: this week's work that supports a goal */
  supporting: number;
  /** M: open tasks in Now plus open tasks due this week (build plan question 41) */
  thisWeekTotal: number;
  unlinked: UnlinkedTask[];
  weekStart: string;
}

/** Open tasks counted with their effective goal, rolled up to the top-level goal. */
async function openTaskGoals(): Promise<{ id: number; title: string; status: string; dueDate: string | null; projectId: number | null; goal: number | null; notGoalWork: boolean }[]> {
  const rows = await db
    .select({
      id: tasksTable.id,
      title: tasksTable.title,
      status: tasksTable.status,
      dueDate: tasksTable.dueDate,
      projectId: tasksTable.projectId,
      notGoalWork: tasksTable.notGoalWork,
      goal: sql<number | null>`(select coalesce(g.parent_id, g.id) from goals g where g.id = ${effectiveGoalSql})`,
    })
    .from(tasksTable)
    .where(inArray(tasksTable.status, OPEN))
    .orderBy(sql`${tasksTable.dueDate} asc nulls last`, asc(tasksTable.createdAt));
  return rows.map((r) => ({ ...r, goal: r.goal == null ? null : Number(r.goal) }));
}

export async function listGoals(today = todayLondon()): Promise<GoalsPage> {
  await ensureSeeds();
  const week = thisWeek(today);
  const [goals, projects, tasks] = await Promise.all([
    db.select().from(goalsTable).orderBy(asc(goalsTable.sortOrder), asc(goalsTable.id)),
    db
      .select({ id: projectsTable.id, name: projectsTable.name, slug: projectsTable.slug, goalId: projectsTable.goalId })
      .from(projectsTable)
      .where(and(sql`${projectsTable.goalId} is not null`, eq(projectsTable.archived, false)))
      .orderBy(asc(projectsTable.name)),
    openTaskGoals(),
  ]);
  const dueThisWeek = (d: string | null) => !!d && d <= week.end;
  const inWeek = tasks.filter((t) => t.status === "now" || dueThisWeek(t.dueDate));

  const top = goals.filter((g) => g.parentId == null);
  const strip = ({ createdAt: _c, updatedAt: _u, ...rest }: Goal) => rest;
  const views: GoalView[] = top.map((g, i) => {
    const subs = goals.filter((s) => s.parentId === g.id);
    const ids = new Set([g.id, ...subs.map((s) => s.id)]);
    const mine = tasks.filter((t) => t.goal === g.id);
    return {
      ...strip(g),
      number: i + 1,
      subGoals: subs.map((s) => ({ ...strip(s), projects: projects.filter((p) => p.goalId === s.id).map(({ goalId: _g, ...p }) => p) })),
      projects: projects.filter((p) => ids.has(p.goalId!)).map((p) => ({ ...p, goalId: p.goalId! })),
      openTasks: mine.length,
      dueThisWeek: mine.filter((t) => dueThisWeek(t.dueDate)).length,
    };
  });

  const projectIds = [...new Set(inWeek.filter((t) => t.goal == null && t.projectId).map((t) => t.projectId!))];
  const projectNames = new Map(
    (projectIds.length
      ? await db.select({ id: projectsTable.id, name: projectsTable.name, slug: projectsTable.slug }).from(projectsTable).where(inArray(projectsTable.id, projectIds))
      : []
    ).map((p) => [p.id, p]),
  );
  return {
    goals: views,
    supporting: inWeek.filter((t) => t.goal != null).length,
    thisWeekTotal: inWeek.length,
    unlinked: inWeek
      .filter((t) => t.goal == null && !t.notGoalWork)
      .map((t) => ({ id: t.id, title: t.title, status: t.status, dueDate: t.dueDate, project: t.projectId ? (projectNames.get(t.projectId) ?? null) : null })),
    weekStart: week.start,
  };
}

/** All goals and sub-goals, for pickers. */
export async function goalOptions(): Promise<GoalSummary[]> {
  return db
    .select({ id: goalsTable.id, name: goalsTable.name, parentId: goalsTable.parentId })
    .from(goalsTable)
    .orderBy(asc(goalsTable.sortOrder), asc(goalsTable.id));
}

export async function assertGoal(id: number | null | undefined): Promise<void> {
  if (id == null) return;
  const [g] = await db.select({ id: goalsTable.id }).from(goalsTable).where(eq(goalsTable.id, id));
  if (!g) throw new NotFoundError("That goal does not exist");
}

export interface GoalInput {
  name: string;
  parentId?: number | null;
  statement?: string | null;
  targetText?: string | null;
  periodStart?: string | null;
  periodEnd?: string | null;
  confidential?: boolean;
  sortOrder?: number;
}

/** Sub-goals are one level deep: a parent must itself be a top-level goal. */
async function checkParent(parentId: number | null | undefined, selfId?: number): Promise<void> {
  if (parentId == null) return;
  if (parentId === selfId) throw new ValidationError("A goal cannot be its own parent");
  const [p] = await db.select({ id: goalsTable.id, parentId: goalsTable.parentId }).from(goalsTable).where(eq(goalsTable.id, parentId));
  if (!p) throw new NotFoundError("That goal does not exist");
  if (p.parentId != null) throw new ValidationError("Sub-goals are one level deep");
  if (selfId != null) {
    const [child] = await db.select({ id: goalsTable.id }).from(goalsTable).where(eq(goalsTable.parentId, selfId)).limit(1);
    if (child) throw new ValidationError("A goal with sub-goals cannot become a sub-goal");
  }
}

function checkPeriod(start: string | null | undefined, end: string | null | undefined) {
  if (start && end && end < start) throw new ValidationError("The end date is before the start date");
}

export async function createGoal(input: GoalInput): Promise<Goal> {
  const name = cleanText(input.name);
  if (!name) throw new ValidationError("A goal needs a name");
  await checkParent(input.parentId);
  checkPeriod(input.periodStart, input.periodEnd);
  return db.transaction(async (tx) => {
    const [max] = await tx.select({ n: sql<number>`coalesce(max(${goalsTable.sortOrder}), 0)::int` }).from(goalsTable);
    const [row] = await tx
      .insert(goalsTable)
      .values({
        name,
        parentId: input.parentId ?? null,
        statement: cleanText(input.statement),
        targetText: cleanText(input.targetText),
        periodStart: input.periodStart ?? null,
        periodEnd: input.periodEnd ?? null,
        // Financial targets are confidential by default (feature 04 rule 2).
        confidential: input.confidential ?? true,
        sortOrder: input.sortOrder ?? Number(max?.n ?? 0) + 1,
      })
      .returning();
    await writeAudit(tx, { actor: ACTOR, action: "create", entityType: "goal", entityId: row.id, payload: { name } });
    return row;
  });
}

export async function updateGoal(id: number, input: Partial<GoalInput>): Promise<Goal> {
  const [current] = await db.select().from(goalsTable).where(eq(goalsTable.id, id));
  if (!current) throw new NotFoundError("That goal does not exist");
  const set: Partial<Goal> = {};
  if (input.name !== undefined) {
    const name = cleanText(input.name);
    if (!name) throw new ValidationError("A goal needs a name");
    set.name = name;
  }
  if (input.parentId !== undefined) {
    await checkParent(input.parentId, id);
    set.parentId = input.parentId;
  }
  if (input.statement !== undefined) set.statement = cleanText(input.statement);
  if (input.targetText !== undefined) set.targetText = cleanText(input.targetText);
  if (input.periodStart !== undefined) set.periodStart = input.periodStart;
  if (input.periodEnd !== undefined) set.periodEnd = input.periodEnd;
  checkPeriod(set.periodStart ?? current.periodStart, set.periodEnd ?? current.periodEnd);
  if (input.confidential !== undefined) set.confidential = input.confidential;
  if (input.sortOrder !== undefined) set.sortOrder = input.sortOrder;
  if (!Object.keys(set).length) return current;
  return db.transaction(async (tx) => {
    const [row] = await tx.update(goalsTable).set(set).where(eq(goalsTable.id, id)).returning();
    const payload: Record<string, unknown> = { fields: Object.keys(set) };
    if (set.confidential !== undefined && set.confidential !== current.confidential) payload.confidential = { from: current.confidential, to: set.confidential };
    await writeAudit(tx, { actor: ACTOR, action: "update", entityType: "goal", entityId: id, payload });
    return row;
  });
}
