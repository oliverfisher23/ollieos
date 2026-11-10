/**
 * Data changes that run once on start-up, each guarded by a flag in app_settings. Publishing
 * applies schema changes automatically but never moves data, so moves happen here instead.
 */
import { sql } from "drizzle-orm";
import { appSettingsTable, db } from "@workspace/db";
import { writeAudit, type DbOrTx } from "../lib/audit";

const RULES_FLAG = "migrated_part_m_rules";

/** Replaces "playbook:<id>" refs with "rule:<id>" in a text[] column. */
const refArray = (table: string, column: string) =>
  sql.raw(`update ${table} set ${column} = array(select regexp_replace(x, '^playbook:', 'rule:') from unnest(${column}) x)
    where exists (select 1 from unnest(${column}) x where x like 'playbook:%')`);

/** Replaces "playbook:<id>" refs with "rule:<id>" inside a jsonb column. */
const refJson = (table: string, column: string) =>
  sql.raw(`update ${table} set ${column} = regexp_replace(${column}::text, '"playbook:([0-9]+)"', '"rule:\\1"', 'g')::jsonb
    where ${column}::text like '%"playbook:%'`);

/**
 * Part M: what were playbooks are now rules. Copies them into `rules` with the same ids, empties the
 * old table, and changes every reference from "playbook" to "rule", all in one transaction. Runs
 * before anything can create a new (process) playbook, so every "playbook" reference found is a rule.
 */
export async function migrateRules(conn: DbOrTx = db): Promise<boolean> {
  return conn.transaction(async (tx) => {
    const flagged = await tx
      .insert(appSettingsTable)
      .values({ key: RULES_FLAG, value: { at: new Date().toISOString() } })
      .onConflictDoNothing()
      .returning({ key: appSettingsTable.key });
    if (!flagged.length) return false;
    // A (process) playbook means this already ran against this data; never turn its links into rules.
    const done = await tx.execute(sql`select 1 from process_playbooks limit 1`);
    if (done.rows.length) return false;
    const copied = await tx.execute(sql`
      insert into rules (id, title, applies_when, rule, enabled, created_by, suggestion_id, created_at, updated_at)
      overriding system value
      select id, title, applies_when, rule, enabled, created_by, suggestion_id, created_at, updated_at from playbooks
      on conflict (id) do nothing`);
    await tx.execute(sql`select setval(pg_get_serial_sequence('rules', 'id'), coalesce((select max(id) from rules), 0) + 1, false)`);
    await tx.execute(sql`delete from playbooks`);
    for (const [table, column] of [
      ["links", "from_type"],
      ["links", "to_type"],
      ["facts", "entity_type"],
      ["notes", "entity_type"],
      ["activity", "entity_type"],
      ["access_requests", "entity_type"],
      ["audit_events", "entity_type"],
      ["suggestions", "entity_type"],
      ["suggestions", "result_type"],
    ]) {
      await tx.execute(sql.raw(`update ${table} set ${column} = 'rule' where ${column} = 'playbook'`));
    }
    await tx.execute(sql`update suggestions set kind = 'rule' where kind = 'playbook'`);
    for (const column of ["input_refs", "cited_ids", "held_back"]) await tx.execute(refArray("meeting_briefs", column));
    await tx.execute(refArray("ask_threads", "cited_ids"));
    for (const column of ["why", "questions", "agenda"]) await tx.execute(refJson("meeting_briefs", column));
    await tx.execute(refJson("ask_threads", "answer"));
    await tx.execute(refJson("digests", "sections"));
    await writeAudit(tx, { actor: "ollie", action: "migrate", payload: { change: "playbooks renamed rules", rules: copied.rowCount ?? 0 } });
    return true;
  });
}

/** Every start-up data change, in order. */
export async function runMigrations(): Promise<void> {
  await migrateRules();
}
