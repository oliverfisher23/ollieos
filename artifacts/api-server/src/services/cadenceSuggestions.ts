/**
 * Suggested cadences for Contacts (feature 05 rule 5, done on demand). For people with no cadence,
 * OllieOS looks at how often Ollie has actually been in touch over the last four months (email,
 * meetings and Slack in the activity log, past calendar meetings, and items captured from email or
 * Slack) and proposes the cadence that matches that rhythm. Active shared projects and client
 * organisations make someone more likely to be suggested. Nothing changes until Ollie sets one;
 * "Not now" hides a person from the suggestions until he clears the list.
 */
import { eq, sql } from "drizzle-orm";
import { appSettingsTable, db, organisationsTable, peopleTable } from "@workspace/db";
import { CADENCE_LABELS, isClientOrgType, type Cadence } from "@workspace/shared";
import { projectsForPeople, type CadenceProject } from "./cadence";
import type { EntitySummary } from "./knowledge/common";

const WINDOW_DAYS = 120;
const DAY = 86_400_000;
const MAX = 12;
const DISMISSED_KEY = "cadence_suggestions_dismissed";

export interface CadenceSuggestion {
  person: {
    id: number;
    name: string;
    slug: string;
    confidential: boolean;
    role: string | null;
    organisation: EntitySummary | null;
    internal: boolean;
  };
  cadence: Cadence;
  cadenceLabel: string;
  /** One line on why, e.g. "In touch on 9 days since July, about every 12 days. On Riipen pilot." */
  reason: string;
  /** Distinct days in touch in the last four months */
  contactDays: number;
  /** Typical gap in days between contacts; null with fewer than two */
  typicalGapDays: number | null;
  lastContactAt: Date | null;
}

export interface CadenceSuggestions {
  suggestions: CadenceSuggestion[];
  /** People hidden with "Not now" */
  dismissed: number;
}

/** The cadence that fits a typical gap between contacts. */
export function cadenceForGap(gap: number): Exclude<Cadence, "none"> {
  if (gap <= 10) return "weekly";
  if (gap <= 21) return "fortnightly";
  if (gap <= 45) return "monthly";
  if (gap <= 75) return "two_monthly";
  return "quarterly";
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** Days between consecutive contact days (YYYY-MM-DD, sorted). */
export function gapsOf(days: string[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < days.length; i++) out.push(Math.round((Date.parse(days[i]) - Date.parse(days[i - 1])) / DAY));
  return out;
}

const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/**
 * Pure part of the suggestion: whether to suggest, which cadence, a score for the order and the reason.
 * Returns null when there is too little to go on.
 */
export function judge(input: { days: string[]; activeProjects: CadenceProject[]; client: boolean; orgName: string | null }) {
  const { days, activeProjects, client, orgName } = input;
  const n = days.length;
  if (!(n >= 3 || (activeProjects.length > 0 && n >= 1) || (client && n >= 2))) return null;
  const gaps = gapsOf(days);
  const gap = gaps.length ? median(gaps) : null;
  // A rhythm needs at least three contact days; otherwise fall back to monthly for active work.
  const cadence: Exclude<Cadence, "none"> = n >= 3 && gap != null ? cadenceForGap(Math.max(gap, 1)) : "monthly";
  const parts = [
    n >= 3 && gap != null
      ? `In touch on ${plural(n, "day")} in the last 4 months, about every ${plural(Math.max(gap, 1), "day")}`
      : `In touch ${n === 1 ? "once" : n === 2 ? "twice" : plural(n, "time")} in the last 4 months`,
    activeProjects.length ? `On ${activeProjects.slice(0, 2).map((p) => p.name).join(" and ")}` : null,
    client && orgName ? `${orgName} is a client or partner` : null,
  ].filter(Boolean);
  return { cadence, gap, score: n + 4 * Math.min(activeProjects.length, 2) + (client ? 3 : 0), reason: parts.join(". ") + "." };
}

async function dismissedIds(): Promise<number[]> {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, DISMISSED_KEY));
  const ids = (row?.value as { ids?: unknown } | undefined)?.ids;
  return Array.isArray(ids) ? ids.filter((x): x is number => typeof x === "number") : [];
}

async function saveDismissed(ids: number[]): Promise<void> {
  const value = { ids: [...new Set(ids)] };
  await db.insert(appSettingsTable).values({ key: DISMISSED_KEY, value }).onConflictDoUpdate({ target: appSettingsTable.key, set: { value } });
}

/** Distinct London days in touch per person since the given time. */
async function contactDays(since: Date, now: Date): Promise<Map<number, string[]>> {
  const s = since.toISOString();
  const n = now.toISOString();
  const res = await db.execute(sql`
    with touches as (
      select a.entity_id as person_id, a.occurred_at as at
        from activity a
       where a.entity_type = 'person' and a.kind in ('email', 'meeting', 'slack') and a.occurred_at >= ${s}::timestamptz
      union all
      select l.to_id, a.occurred_at
        from activity a join links l on l.from_type = 'activity' and l.from_id = a.id and l.to_type = 'person'
       where a.kind in ('email', 'meeting', 'slack') and a.occurred_at >= ${s}::timestamptz
      union all
      select unnest(c.person_ids), c.starts_at
        from calendar_events c
       where not c.personal and c.starts_at >= ${s}::timestamptz and c.starts_at <= ${n}::timestamptz
      union all
      select t.person_id, coalesce(t.captured_at, t.created_at)
        from tasks t
       where t.person_id is not null and t.source <> 'manual' and coalesce(t.captured_at, t.created_at) >= ${s}::timestamptz
    )
    select person_id, array_agg(distinct to_char(at at time zone 'Europe/London', 'YYYY-MM-DD') order by to_char(at at time zone 'Europe/London', 'YYYY-MM-DD')) as days
      from touches
     where person_id is not null and at <= ${n}::timestamptz
     group by person_id`);
  return new Map((res.rows as { person_id: number; days: string[] }[]).map((r) => [Number(r.person_id), r.days]));
}

export async function suggestCadences(now = new Date()): Promise<CadenceSuggestions> {
  const [dismissed, rows] = await Promise.all([
    dismissedIds(),
    db
      .select({
        id: peopleTable.id,
        name: peopleTable.name,
        slug: peopleTable.slug,
        confidential: peopleTable.confidential,
        role: peopleTable.role,
        lastContactAt: peopleTable.lastContactAt,
        orgId: organisationsTable.id,
        orgName: organisationsTable.name,
        orgSlug: organisationsTable.slug,
        orgConfidential: organisationsTable.confidential,
        orgType: organisationsTable.type,
        orgInternal: organisationsTable.internal,
      })
      .from(peopleTable)
      .leftJoin(organisationsTable, eq(organisationsTable.id, peopleTable.organisationId))
      .where(sql`${peopleTable.cadence} = 'none' and not ${peopleTable.isSelf}`),
  ]);
  const hidden = new Set(dismissed);
  const candidates = rows.filter((r) => !hidden.has(r.id));
  if (!candidates.length) return { suggestions: [], dismissed: dismissed.length };
  const [days, projects] = await Promise.all([contactDays(new Date(now.getTime() - WINDOW_DAYS * DAY), now), projectsForPeople(candidates.map((r) => r.id))]);

  const scored: (CadenceSuggestion & { score: number })[] = [];
  for (const r of candidates) {
    const verdict = judge({
      days: days.get(r.id) ?? [],
      activeProjects: (projects.get(r.id) ?? []).filter((p) => p.lifecycle === "active"),
      client: !r.orgInternal && isClientOrgType(r.orgType),
      orgName: r.orgName,
    });
    if (!verdict) continue;
    scored.push({
      person: {
        id: r.id,
        name: r.name,
        slug: r.slug,
        confidential: r.confidential,
        role: r.role,
        organisation: r.orgId ? { id: r.orgId, name: r.orgName!, slug: r.orgSlug!, confidential: r.orgConfidential! } : null,
        internal: !!r.orgInternal,
      },
      cadence: verdict.cadence,
      cadenceLabel: CADENCE_LABELS[verdict.cadence],
      reason: verdict.reason,
      contactDays: days.get(r.id)?.length ?? 0,
      typicalGapDays: verdict.gap,
      lastContactAt: r.lastContactAt,
      score: verdict.score,
    });
  }
  scored.sort((a, b) => b.score - a.score || a.person.name.localeCompare(b.person.name, "en-GB"));
  return { suggestions: scored.slice(0, MAX).map(({ score: _score, ...s }) => s), dismissed: dismissed.length };
}

/** "Not now": the person stops being suggested. */
export async function dismissCadenceSuggestion(personId: number): Promise<void> {
  await saveDismissed([...(await dismissedIds()), personId]);
}

/** Brings back everyone hidden with "Not now". */
export async function clearDismissedCadenceSuggestions(): Promise<void> {
  await saveDismissed([]);
}
