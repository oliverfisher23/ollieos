import { sql } from "drizzle-orm";
import { aiActivityGroupsTable, auditEventsTable, db } from "@workspace/db";

type Db = typeof db;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export type DbOrTx = Db | Tx;

export type EntityType = (typeof auditEventsTable.$inferInsert)["entityType"];

export interface AuditInput {
  /** "ollie", "ingest", "claude", or the AI client name */
  actor: string;
  action: string;
  entityType?: EntityType;
  entityId?: number | null;
  clientId?: number | null;
  payload?: unknown;
}

/** Records who did what. Call inside the same transaction as the write. */
export async function writeAudit(conn: DbOrTx, input: AuditInput): Promise<void> {
  await appendAuditEvents(conn, [{
    actor: input.actor,
    action: input.action,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    clientId: input.clientId ?? null,
    payload: input.payload ?? null,
  }]);
}

/** Keep recent-group navigation atomic with all event writers, including bulk AI reads. */
export async function appendAuditEvents(conn: DbOrTx, events: (typeof auditEventsTable.$inferInsert)[]): Promise<void> {
  if (!events.length) return;
  if (!events.some((event) => event.clientId != null && event.actor !== "ollie")) {
    await conn.insert(auditEventsTable).values(events);
    return;
  }
  if (conn === db) {
    await db.transaction((tx) => appendAuditEvents(tx, events));
    return;
  }
  const rows = await conn.insert(auditEventsTable).values(events).returning({
    key: sql<string | null>`case when client_id is not null and actor <> 'ollie'
      then coalesce(payload->>'batch', 'e' || id::text) end`,
    at: auditEventsTable.createdAt,
  });
  const groups = new Map<string, Date>();
  for (const row of rows) {
    if (row.key == null) continue;
    if (!groups.has(row.key) || groups.get(row.key)! < row.at) groups.set(row.key, row.at);
  }
  if (groups.size) await conn.insert(aiActivityGroupsTable).values([...groups].map(([key, at]) => ({ key, at })))
    .onConflictDoUpdate({
      target: aiActivityGroupsTable.key,
      set: { at: sql`greatest(${aiActivityGroupsTable.at}, excluded.at)` },
    });
}
