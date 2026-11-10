/**
 * First-run content for milestone 7 (build plan questions 36 and 45): the three goals named in
 * feature 04, with blank statements and targets, and the six seed playbooks with the Library
 * screen's wording. Created once; a flag in app_settings stops deleted or renamed rows coming back.
 */
import { eq, sql } from "drizzle-orm";
import { appSettingsTable, db, goalsTable, playbooksTable } from "@workspace/db";
import { writeAudit } from "../lib/audit";

const FLAG = "seeded_direction";

export const SEED_GOALS = [
  { name: "Growth", confidential: true },
  { name: "Efficiency", confidential: true },
  { name: "Product and market expansion", confidential: false },
] as const;

export const SEED_PLAYBOOKS = [
  {
    title: "Writing style",
    appliesWhen: "Any text written for me or as me",
    rule: "British English. No em dashes. Dates as ordinals with the full month. No marketing language or filler.",
  },
  {
    title: "PwC terminology",
    appliesWhen: "Any PwC material",
    rule: "Say experience credits, never learner credits.",
  },
  {
    title: "Micro Internship claims",
    appliesWhen: "Describing Micro Internships",
    rule: "Describe it as applied work, not a course. Check product claims against the Micro Internships knowledge base before using them.",
  },
  {
    title: "Defence talks",
    appliesWhen: "Defence meetings and decks",
    rule: "Never present drafted briefs as live programmes. The Rolls-Royce Unity brief is not a live student programme.",
  },
  {
    title: "RAF framing",
    appliesWhen: "RAF Micro Internship material",
    rule: "Frame it as a way to express interest in Foundation Year and gather feedback, not as driving applications.",
  },
  {
    title: "Build requests",
    appliesWhen: "Replit or code work",
    rule: "Treat improve X requests as audit and plan. Do not start building without an explicit build instruction.",
  },
] as const;

let seeded = false;

/** Creates the seed goals and playbooks the first time it runs against a database. */
export async function ensureSeeds(): Promise<void> {
  if (seeded) return;
  await db.transaction(async (tx) => {
    // Locks the flag row so two requests at once cannot both seed.
    const inserted = await tx
      .insert(appSettingsTable)
      .values({ key: FLAG, value: { at: new Date().toISOString() } })
      .onConflictDoNothing()
      .returning({ key: appSettingsTable.key });
    if (!inserted.length) return;
    const goals = await tx
      .insert(goalsTable)
      .values(SEED_GOALS.map((g, i) => ({ name: g.name, confidential: g.confidential, sortOrder: i + 1 })))
      .returning({ id: goalsTable.id, name: goalsTable.name });
    const playbooks = await tx
      .insert(playbooksTable)
      .values(SEED_PLAYBOOKS.map((p) => ({ ...p, createdBy: "ollie" })))
      .returning({ id: playbooksTable.id, title: playbooksTable.title });
    // Last contact from the timeline logged before cadence existed: the latest email, meeting or
    // Slack touchpoint against each person, directly or through links.
    const backfill = await tx.execute(sql`
      with touch as (
        select a.entity_id as person_id, a.occurred_at from activity a
          where a.entity_type = 'person' and a.kind in ('email', 'meeting', 'slack')
        union all
        select case when l.from_type = 'person' then l.from_id else l.to_id end, a.occurred_at
          from activity a join links l on
            (l.from_type = 'activity' and l.from_id = a.id and l.to_type = 'person') or
            (l.to_type = 'activity' and l.to_id = a.id and l.from_type = 'person')
          where a.kind in ('email', 'meeting', 'slack')
      ), latest as (select person_id, max(occurred_at) as at from touch group by person_id)
      update people p set last_contact_at = latest.at from latest
      where p.id = latest.person_id and (p.last_contact_at is null or p.last_contact_at < latest.at)`);
    await writeAudit(tx, {
      actor: "ollie",
      action: "seed",
      payload: { goals: goals.map((g) => g.id), playbooks: playbooks.map((p) => p.id), lastContactBackfilled: backfill.rowCount ?? 0 },
    });
  });
  seeded = true;
}

/** For tests, which empty the database between cases. */
export function resetSeedCheck() {
  seeded = false;
}

/** True once the seed has run (used by tests). */
export async function seedFlagSet(): Promise<boolean> {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, FLAG));
  return !!row;
}
