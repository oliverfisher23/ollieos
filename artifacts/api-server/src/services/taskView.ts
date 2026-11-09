import { inArray } from "drizzle-orm";
import { db, peopleTable, projectsTable, type Task as TaskRow } from "@workspace/db";
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
};

/** Turns task rows into the API shape, resolving project and people links in two queries. */
export async function toTaskViews(rows: TaskRow[], conn: DbOrTx = db): Promise<TaskView[]> {
  const personIds = new Set<number>();
  const projectIds = new Set<number>();
  for (const r of rows) {
    if (r.personId) personIds.add(r.personId);
    if (r.waitingOnPersonId) personIds.add(r.waitingOnPersonId);
    if (r.projectId) projectIds.add(r.projectId);
  }

  const [people, projects] = await Promise.all([
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
  ]);

  const personById = new Map(people.map((p) => [p.id, p]));
  const projectById = new Map(projects.map((p) => [p.id, p]));

  return rows.map((r) => {
    const { search: _search, personId, projectId, waitingOnPersonId, noiseRuleId: _rule, sourceChannel: _channel, ...rest } = r;
    return {
      ...rest,
      project: projectId ? (projectById.get(projectId) ?? null) : null,
      person: personId ? (personById.get(personId) ?? null) : null,
      waitingOn: waitingOnPersonId ? (personById.get(waitingOnPersonId) ?? null) : null,
    };
  });
}

export async function toTaskView(row: TaskRow, conn: DbOrTx = db): Promise<TaskView> {
  const [view] = await toTaskViews([row], conn);
  return view;
}
