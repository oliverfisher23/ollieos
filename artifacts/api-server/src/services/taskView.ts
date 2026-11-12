import { and, eq, inArray, sql } from "drizzle-orm";
import { db, goalsTable, noiseRulesTable, peopleTable, projectsTable, taskEvidenceTable, tasksTable, type Task as TaskRow } from "@workspace/db";
import { taskVisible } from "../lib/ai-data/visibility";
import { noiseRuleLabel } from "./noiseRules";
import { looksDoneFor } from "./taskEvidence";
import type { DbOrTx } from "../lib/audit";
import { CHASE_AFTER_DAYS } from "@workspace/shared";

export interface EntitySummary {
  id: number;
  name: string;
  slug: string;
  confidential: boolean;
}

export type TaskView = Omit<TaskRow, "search" | "personId" | "projectId" | "waitingOnPersonId" | "noiseRuleId" | "sourceChannel" | "noiseHintKept" | "noiseCheckedAt" | "repeatNextId" | "delegateCheckedAt" | "delegateDismissedAt" | "personCheckedAt" | "stuckCheckedAt" | "stuckDismissedAt" | "chaseAfter"> & {
  /** Section 27: a Waiting on task that has waited long enough for a chase */
  chaseDue: boolean;
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
  /** Part U: one line of evidence from elsewhere that this open task is done, or null */
  looksDone: string | null;
  /** Section 26: the other sources the same work came up in (slack, email, meeting, session...) */
  alsoFrom: string[];
};

/** Statuses a task can still be marked done from. */
const OPEN_FOR_EVIDENCE = new Set(["inbox", "now", "backlog", "waiting"]);

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
  const looks = await looksDoneFor(rows.filter((r) => OPEN_FOR_EVIDENCE.has(r.status)).map((r) => r.id));
  // Section 26: where else the same work came up.
  const alsoRows = taskIds.length
    ? await conn
        .selectDistinct({ taskId: taskEvidenceTable.taskId, source: taskEvidenceTable.source })
        .from(taskEvidenceTable)
        .where(and(inArray(taskEvidenceTable.taskId, taskIds), eq(taskEvidenceTable.shows, "same")))
    : [];
  const also = new Map<number, string[]>();
  for (const a of alsoRows) also.set(a.taskId, [...(also.get(a.taskId) ?? []), a.source].sort());
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
    const { search: _search, personId, projectId, waitingOnPersonId, noiseRuleId, sourceChannel: _channel, noiseHintKept, noiseCheckedAt: _checked, repeatNextId: _next, delegateCheckedAt: _dc, delegateDismissedAt, personCheckedAt: _pc, stuckCheckedAt: _sc, stuckDismissedAt, chaseAfter, ...rest } = r;
    const chaseFrom = chaseAfter ?? new Date((r.waitingSince ?? r.createdAt).getTime() + CHASE_AFTER_DAYS * 86_400_000);
    return {
      ...rest,
      project: projectId ? (projectById.get(projectId) ?? null) : null,
      person: personId ? (personById.get(personId) ?? null) : null,
      waitingOn: waitingOnPersonId ? (personById.get(waitingOnPersonId) ?? null) : null,
      stale: r.status === "backlog" && now - r.updatedAt.getTime() >= STALE_MS,
      noiseRule: noiseRuleId ? (ruleById.get(noiseRuleId) ?? null) : null,
      hiddenFromAi: hiddenSet.has(r.id),
      goal: goalFor(r),
      // "Probably noise" only matters while the item waits in the Inbox.
      noiseHint: r.status === "inbox" && !noiseHintKept ? r.noiseHint : null,
      // Part U: evidence from elsewhere that an open task is done.
      looksDone: OPEN_FOR_EVIDENCE.has(r.status) ? (looks.get(r.id) ?? null) : null,
      alsoFrom: [...new Set(also.get(r.id) ?? [])].filter((s) => s !== r.source),
      // Section 23: who could take it, while it is still Ollie's to do and he has not said "Not this one".
      delegateHint: (r.status === "now" || r.status === "backlog") && !delegateDismissedAt ? r.delegateHint : null,
      // Section 27: chase nudges and the stuck-task coach.
      chaseDue: r.status === "waiting" && chaseFrom.getTime() <= now,
      stuckHint: (r.status === "now" || r.status === "backlog") && !stuckDismissedAt ? r.stuckHint : null,
      // Section 28: the reader's guess at a date, while the task has none and is still open.
      suggestedDue: !r.dueDate && OPEN_FOR_EVIDENCE.has(r.status) ? r.suggestedDue : null,
    };
  });
}

export async function toTaskView(row: TaskRow, conn: DbOrTx = db): Promise<TaskView> {
  const [view] = await toTaskViews([row], conn);
  return view;
}
