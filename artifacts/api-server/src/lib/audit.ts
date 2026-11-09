import { auditEventsTable, db } from "@workspace/db";

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
  await conn.insert(auditEventsTable).values({
    actor: input.actor,
    action: input.action,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    clientId: input.clientId ?? null,
    payload: input.payload ?? null,
  });
}
