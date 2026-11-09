import { and, inArray, sql } from "drizzle-orm";
import { db, noiseRulesTable, peopleTable, projectsTable, tasksTable, type Task as TaskRow } from "@workspace/db";
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
          .select({ id: projectsTable.id, name: projectsTable.name, slug: projectsTable.slug, confidential: projectsTable.confidential })
          .from(projectsTable)
          .where(inArray(projectsTable.id, [...projectIds]))
      : Promise.resolve([] as EntitySummary[]),
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
  const ruleById = new Map(rules.map((r) => [r.id, { ...r, label: noiseRuleLabel(r.matchType, r.matchValue) }]));
  const now = Date.now();

  const personById = new Map(people.map((p) => [p.id, p]));
  const projectById = new Map(projects.map((p) => [p.id, p]));

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
    };
  });
}

export async function toTaskView(row: TaskRow, conn: DbOrTx = db): Promise<TaskView> {
  const [view] = await toTaskViews([row], conn);
  return view;
}
