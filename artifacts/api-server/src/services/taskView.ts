import { and, inArray, sql } from "drizzle-orm";
import { db, goalsTable, noiseRulesTable, peopleTable, projectsTable, tasksTable, type Task as TaskRow } from "@workspace/db";
import { taskVisible } from "../lib/ai-data/visibility";
import { noiseRuleLabel } from "./noiseRules";
import type { DbOrTx } from "../lib/audit";

export interface EntitySummary {
  id: number;
  name: string;
  slug: string;
  confidential: boolean;
}

export type TaskView = Omit<TaskRow, "search" | "personId" | "projectId" | "waitingOnPersonId" | "noiseRuleId" | "sourceChannel"> & {
  project: EntitySummary | null;
  person: EntitySummary | null;
  waitingOn: EntitySummary | null;
  /** Backlog item untouched for 30 days or more */
  stale: boolean;
  noiseRule: { id: number; matchType: string; matchValue: string; label: string } | null;
  /** AI tools cannot read this task without an approval (own flag or inherited) */
  hiddenFromAi: boolean;
  /** The goal it counts towards: its own link, else its project's (inherited) */
  goal: { id: number; name: string; inherited: boolean } | null;
};

const STALE_MS = 30 * 24 * 60 * 60 * 1000;

/** Turns task rows into the API shape, resolving project and people links in two queries. */
export async function toTaskViews(rows: TaskRow[], conn: DbOrTx = db): Promise<TaskView[]> {
  const personIds = new Set<number>();
  const projectIds = new Set<number>();
  const ruleIds = new Set<number>();
  for (const r of rows) {
    if (r.noiseRuleId) ruleIds.add(r.noiseRuleId);
    if (r.personId) personIds.add(r.personId);
    if (r.waitingOnPersonId) personIds.add(r.waitingOnPersonId);
    if (r.projectId) projectIds.add(r.projectId);
  }

  const taskIds = rows.map((r) => r.id);
  const [people, projects, rules, hidden] = await Promise.all([
    personIds.size
      ? conn
          .select({ id: peopleTable.id, name: peopleTable.name, slug: peopleTable.slug, confidential: peopleTable.confidential })
          .from(peopleTable)
          .where(inArray(peopleTable.id, [...personIds]))
      : Promise.resolve([] as EntitySummary[]),
    projectIds.size
      ? conn
          .select({ id: projectsTable.id, name: projectsTable.name, slug: projectsTable.slug, confidential: projectsTable.confidential, goalId: projectsTable.goalId })
          .from(projectsTable)
          .where(inArray(projectsTable.id, [...projectIds]))
      : Promise.resolve([] as (EntitySummary & { goalId: number | null })[]),
    ruleIds.size
      ? conn
          .select({ id: noiseRulesTable.id, matchType: noiseRulesTable.matchType, matchValue: noiseRulesTable.matchValue })
          .from(noiseRulesTable)
          .where(inArray(noiseRulesTable.id, [...ruleIds]))
      : Promise.resolve([]),
    taskIds.length
      ? conn
          .select({ id: tasksTable.id })
          .from(tasksTable)
          .where(and(inArray(tasksTable.id, taskIds), sql.raw(`not ${taskVisible("tasks")}`)))
      : Promise.resolve([] as { id: number }[]),
  ]);
  const hiddenSet = new Set(hidden.map((h) => h.id));
  const goalIds = new Set<number>();
  for (const r of rows) if (r.goalId) goalIds.add(r.goalId);
  for (const p of projects) if (p.goalId) goalIds.add(p.goalId);
  const goals = goalIds.size
    ? await conn.select({ id: goalsTable.id, name: goalsTable.name }).from(goalsTable).where(inArray(goalsTable.id, [...goalIds]))
    : [];
  const goalById = new Map(goals.map((g) => [g.id, g]));
  const ruleById = new Map(rules.map((r) => [r.id, { ...r, label: noiseRuleLabel(r.matchType, r.matchValue) }]));
  const now = Date.now();

  const personById = new Map(people.map((p) => [p.id, p]));
  const projectById = new Map(projects.map(({ goalId: _g, ...p }) => [p.id, p]));
  const projectGoal = new Map(projects.map((p) => [p.id, p.goalId]));
  const goalFor = (r: TaskRow): TaskView["goal"] => {
    if (r.goalId) {
      const g = goalById.get(r.goalId);
      return g ? { ...g, inherited: false } : null;
    }
    const pg = r.projectId ? projectGoal.get(r.projectId) : null;
    const g = pg ? goalById.get(pg) : null;
    return g ? { ...g, inherited: true } : null;
  };

  return rows.map((r) => {
    const { search: _search, personId, projectId, waitingOnPersonId, noiseRuleId, sourceChannel: _channel, ...rest } = r;
    return {
      ...rest,
      project: projectId ? (projectById.get(projectId) ?? null) : null,
      person: personId ? (personById.get(personId) ?? null) : null,
      waitingOn: waitingOnPersonId ? (personById.get(waitingOnPersonId) ?? null) : null,
      stale: r.status === "backlog" && now - r.updatedAt.getTime() >= STALE_MS,
      noiseRule: noiseRuleId ? (ruleById.get(noiseRuleId) ?? null) : null,
      hiddenFromAi: hiddenSet.has(r.id),
      goal: goalFor(r),
    };
  });
}

export async function toTaskView(row: TaskRow, conn: DbOrTx = db): Promise<TaskView> {
  const [view] = await toTaskViews([row], conn);
  return view;
}
