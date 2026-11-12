/**
 * get_strategy (build plan Part H): Ollie's strategy sections in his order, and his open ideas.
 * Hidden sections and ideas are filtered in the WHERE clause and never fetched; linked project names
 * are only sent when the project is visible too. Every item handed out is logged with recordReads.
 */
import { and, asc, desc, inArray, sql } from "drizzle-orm";
import { db, goalsTable, ideasTable, projectsTable, strategySectionsTable } from "@workspace/db";
import { todayLondon, toRef } from "@workspace/shared";
import { ideaVisible, projectVisible, strategyVisible } from "./visibility";
import { recordReads, type AiScope } from "./scope";
import type { NamedRef } from "./context";

export interface StrategyOut {
  sections: { ref: string; name: string; text: string; updated_at: string; goals: NamedRef[]; projects: NamedRef[] }[];
  ideas: {
    ref: string;
    title: string;
    notes: string | null;
    status: "new" | "come_back";
    come_back_on: string | null;
    due: boolean;
    added_by: "ollie" | "claude" | "session" | "ollieos";
    created_at: string;
    goal: NamedRef | null;
    project: NamedRef | null;
  }[];
}

const OPEN_IDEAS = 100;

export async function strategyForAi(scope: AiScope): Promise<StrategyOut> {
  const g = scope.grants;
  const [sections, ideas] = await Promise.all([
    db
      .select()
      .from(strategySectionsTable)
      .where(sql.raw(strategyVisible("strategy_sections", g)))
      .orderBy(asc(strategySectionsTable.sortOrder), asc(strategySectionsTable.id)),
    db
      .select()
      .from(ideasTable)
      .where(and(inArray(ideasTable.status, ["new", "come_back"]), sql.raw(ideaVisible("ideas", g))))
      .orderBy(desc(ideasTable.createdAt))
      .limit(OPEN_IDEAS),
  ]);
  const goalIds = [...new Set([...sections.flatMap((s) => s.goalIds), ...ideas.map((i) => i.goalId).filter((x): x is number => x != null)])];
  const projectIds = [...new Set([...sections.flatMap((s) => s.projectIds), ...ideas.map((i) => i.projectId).filter((x): x is number => x != null)])];
  const [goals, projects] = await Promise.all([
    goalIds.length ? db.select({ id: goalsTable.id, name: goalsTable.name }).from(goalsTable).where(inArray(goalsTable.id, goalIds)) : [],
    projectIds.length
      ? db
          .select({ id: projectsTable.id, name: projectsTable.name })
          .from(projectsTable)
          .where(and(inArray(projectsTable.id, projectIds), sql.raw(projectVisible("projects", g))))
      : [],
  ]);
  const goal = new Map(goals.map((x) => [x.id, { ref: toRef("goal", x.id), name: x.name }]));
  const project = new Map(projects.map((x) => [x.id, { ref: toRef("project", x.id), name: x.name }]));
  const today = todayLondon();

  const out: StrategyOut = {
    sections: sections.map((s) => ({
      ref: toRef("strategy", s.id),
      name: s.name,
      text: s.body,
      updated_at: s.updatedAt.toISOString(),
      goals: s.goalIds.map((id) => goal.get(id)).filter((x): x is NamedRef => !!x),
      projects: s.projectIds.map((id) => project.get(id)).filter((x): x is NamedRef => !!x),
    })),
    ideas: ideas.map((i) => ({
      ref: toRef("idea", i.id),
      title: i.title,
      notes: i.notes,
      status: i.status as "new" | "come_back",
      come_back_on: i.status === "come_back" ? i.comeBackOn : null,
      due: i.status === "come_back" && i.comeBackOn != null && i.comeBackOn <= today,
      added_by: i.source,
      created_at: i.createdAt.toISOString(),
      goal: i.goalId != null ? (goal.get(i.goalId) ?? null) : null,
      project: i.projectId != null ? (project.get(i.projectId) ?? null) : null,
    })),
  };
  await recordReads(scope, [...out.sections.map((s) => s.ref), ...out.ideas.map((i) => i.ref)], { via: "get_strategy" });
  return out;
}

/** A goal by ref ("goal:3") or name, exact first, then the only partial match. Goals are always visible by name. */
export async function resolveGoalForAi(value: string): Promise<{ id: number; name: string } | null> {
  const v = value.trim();
  const ref = /^goal:(\d+)$/.exec(v);
  const goals = await db.select({ id: goalsTable.id, name: goalsTable.name }).from(goalsTable);
  if (ref) return goals.find((g) => g.id === Number(ref[1])) ?? null;
  const lower = v.toLowerCase();
  const exact = goals.find((g) => g.name.trim().toLowerCase() === lower);
  if (exact) return exact;
  const partial = goals.filter((g) => g.name.toLowerCase().includes(lower));
  return partial.length === 1 ? partial[0] : null;
}
