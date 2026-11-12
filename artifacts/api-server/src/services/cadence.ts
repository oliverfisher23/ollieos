/**
 * Relationship cadence (feature 05). Last contact is people.last_contact_at, kept up to date on
 * every activity insert of kind email, meeting or Slack. A cadence pauses when Ollie pauses it, or
 * when every project linked to the person is paused or complete (build plan question 38).
 */
import { asc, eq, sql } from "drizzle-orm";
import { db, organisationsTable, peopleTable, type Person } from "@workspace/db";
import {
  CADENCE_LABELS,
  cadenceState,
  daysBetween,
  londonDate,
  relationshipStrength,
  todayLondon,
  type Strength,
  type Cadence,
  type CadenceState,
  type CadenceStatus,
} from "@workspace/shared";

/** Strong, warm, cooling or cold, from the last contact and the days in touch in the strength window. */
export function strengthOf(lastContactAt: Date | null, contactDayCount: number, today = todayLondon()): Strength {
  const daysSince = lastContactAt ? Math.max(0, daysBetween(londonDate(lastContactAt), today)) : null;
  return relationshipStrength({ daysSince, contactDays: contactDayCount });
}

export const CADENCE_TABS = ["all", "overdue", "due_soon", "on_track"] as const;
export type CadenceTab = (typeof CADENCE_TABS)[number];

export interface CadenceProject {
  id: number;
  name: string;
  slug: string;
  lifecycle: "active" | "paused" | "complete";
}

export interface CadenceRow extends CadenceState {
  id: number;
  name: string;
  slug: string;
  confidential: boolean;
  role: string | null;
  organisation: { id: number; name: string; slug: string } | null;
  project: CadenceProject | null;
  cadence: Cadence;
  cadenceLabel: string;
  cadencePaused: boolean;
  /** True when the pause comes from the person's projects rather than Ollie */
  pausedByProjects: boolean;
  lastContactAt: Date | null;
}

/**
 * Projects linked to each person: through links either way round, or through their non-noise tasks.
 * The same set the person page lists.
 */
export async function projectsForPeople(ids: number[]): Promise<Map<number, CadenceProject[]>> {
  const out = new Map<number, CadenceProject[]>();
  if (!ids.length) return out;
  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const res = await db.execute(sql`
    with pp as (
      select from_id as person_id, to_id as project_id from links where from_type = 'person' and to_type = 'project' and from_id in (${list})
      union select to_id, from_id from links where to_type = 'person' and from_type = 'project' and to_id in (${list})
      union select person_id, project_id from tasks where person_id in (${list}) and project_id is not null and status <> 'noise'
      union select waiting_on_person_id, project_id from tasks where waiting_on_person_id in (${list}) and project_id is not null and status <> 'noise'
    )
    select pp.person_id, p.id, p.name, p.slug, p.lifecycle
    from pp join projects p on p.id = pp.project_id
    order by (p.lifecycle = 'active') desc, p.updated_at desc`);
  for (const r of res.rows as { person_id: number; id: number; name: string; slug: string; lifecycle: CadenceProject["lifecycle"] }[]) {
    const pid = Number(r.person_id);
    if (!out.has(pid)) out.set(pid, []);
    out.get(pid)!.push({ id: Number(r.id), name: r.name, slug: r.slug, lifecycle: r.lifecycle });
  }
  return out;
}

/** True when the person has linked projects and none of them is active. */
export function pausedByProjects(projects: CadenceProject[] | undefined): boolean {
  return !!projects?.length && projects.every((p) => p.lifecycle !== "active");
}

export function stateFor(p: Pick<Person, "cadence" | "cadencePaused" | "lastContactAt">, projects: CadenceProject[] | undefined, today = todayLondon()): CadenceState {
  const daysSince = p.lastContactAt ? Math.max(0, daysBetween(londonDate(p.lastContactAt), today)) : null;
  return cadenceState({ cadence: p.cadence, paused: p.cadencePaused || pausedByProjects(projects), daysSince });
}

const ORDER: Record<CadenceStatus, number> = { overdue: 0, due_soon: 1, on_track: 2, paused: 3, none: 4 };

/** Everyone with a cadence (never Ollie's own record), with status and the counts for each tab. */
export async function listCadence(tab: CadenceTab = "all", today = todayLondon()) {
  const rows = await db
    .select({
      person: peopleTable,
      orgId: organisationsTable.id,
      orgName: organisationsTable.name,
      orgSlug: organisationsTable.slug,
    })
    .from(peopleTable)
    .leftJoin(organisationsTable, eq(organisationsTable.id, peopleTable.organisationId))
    .where(sql`${peopleTable.cadence} <> 'none' and not ${peopleTable.isSelf}`)
    .orderBy(asc(peopleTable.name));
  const projects = await projectsForPeople(rows.map((r) => r.person.id));
  const all: CadenceRow[] = rows.map(({ person: p, orgId, orgName, orgSlug }) => {
    const mine = projects.get(p.id);
    const state = stateFor(p, mine, today);
    return {
      ...state,
      id: p.id,
      name: p.name,
      slug: p.slug,
      confidential: p.confidential,
      role: p.role,
      organisation: orgId != null ? { id: Number(orgId), name: orgName!, slug: orgSlug! } : null,
      project: mine?.[0] ?? null,
      cadence: p.cadence,
      cadenceLabel: CADENCE_LABELS[p.cadence],
      cadencePaused: p.cadencePaused,
      pausedByProjects: !p.cadencePaused && pausedByProjects(mine),
      lastContactAt: p.lastContactAt,
    };
  });
  all.sort((a, b) => ORDER[a.status] - ORDER[b.status] || (b.daysOverdue ?? 0) - (a.daysOverdue ?? 0) || (a.daysLeft ?? 0) - (b.daysLeft ?? 0) || a.name.localeCompare(b.name, "en-GB"));
  const counts = {
    all: all.length,
    overdue: all.filter((r) => r.status === "overdue").length,
    due_soon: all.filter((r) => r.status === "due_soon").length,
    on_track: all.filter((r) => r.status === "on_track").length,
  };
  const people = tab === "all" ? all : all.filter((r) => r.status === tab);
  return { tab, counts, people };
}

/** Cadence and status for one person, for the person page. */
export async function cadenceFor(person: Person, today = todayLondon()) {
  const projects = await projectsForPeople([person.id]);
  const mine = projects.get(person.id);
  return {
    ...stateFor(person, mine, today),
    cadence: person.cadence,
    cadenceLabel: CADENCE_LABELS[person.cadence],
    cadencePaused: person.cadencePaused,
    pausedByProjects: !person.cadencePaused && pausedByProjects(mine),
  };
}

/** Sets a person's last contact to the given time if it is later than what is on file. */
export async function recordContact(conn: Pick<typeof db, "update">, personIds: number[], at: Date): Promise<void> {
  for (const id of personIds) {
    await conn
      .update(peopleTable)
      // New contact also brings an archived person back into Contacts.
      .set({ lastContactAt: sql`greatest(coalesce(${peopleTable.lastContactAt}, ${at.toISOString()}::timestamptz), ${at.toISOString()}::timestamptz)`, archived: false })
      .where(eq(peopleTable.id, id));
  }
}
