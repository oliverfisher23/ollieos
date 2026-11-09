/**
 * Connected AI tools: the Capture sweep (ingest API key), Revoke and Reconnect, and the
 * sweep status shown in Settings.
 */
import { timingSafeEqual } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { aiClientsTable, db, sweepRunsTable, type AiClient } from "@workspace/db";
import { writeAudit } from "../lib/audit";
import { revokeClientTokens } from "../oauth/store";
import { lastSweepFinishedAt } from "../lib/ai-data/context";
import { ConflictError, NotFoundError } from "./tasks";

export const CAPTURE_SWEEP_NAME = "Capture sweep";

/** The "Capture sweep" client that the ingest key belongs to. Created on first use. */
export async function captureSweepClient(): Promise<AiClient> {
  const [found] = await db
    .select()
    .from(aiClientsTable)
    .where(and(eq(aiClientsTable.name, CAPTURE_SWEEP_NAME), eq(aiClientsTable.auth, "api_key")))
    .orderBy(aiClientsTable.id)
    .limit(1);
  if (found) return found;
  const [created] = await db
    .insert(aiClientsTable)
    .values({ name: CAPTURE_SWEEP_NAME, kind: "scheduled_task", auth: "api_key", scopes: ["read", "write"], connectedAt: new Date() })
    .returning();
  return created;
}

export function ingestKeyConfigured(): boolean {
  return !!process.env.INBOX_API_KEY;
}

/** Constant-time comparison with INBOX_API_KEY. False when no key is set. */
export function ingestKeyMatches(given: string): boolean {
  const key = process.env.INBOX_API_KEY;
  if (!key || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function loadClient(id: number): Promise<AiClient> {
  const [row] = await db.select().from(aiClientsTable).where(eq(aiClientsTable.id, id));
  if (!row) throw new NotFoundError("That tool does not exist");
  return row;
}

/**
 * Revoke: the tool loses access at once. OAuth tokens are revoked; for the Capture sweep the
 * ingest key is refused until Reconnect (question 19).
 */
export async function revokeClient(id: number): Promise<AiClient> {
  const client = await loadClient(id);
  if (client.auth === "internal") throw new ConflictError("Ask OllieOS is built in and cannot be revoked");
  if (client.revokedAt) return client;
  return db.transaction(async (tx) => {
    const [row] = await tx.update(aiClientsTable).set({ revokedAt: new Date() }).where(eq(aiClientsTable.id, id)).returning();
    await revokeClientTokens(id, tx);
    await writeAudit(tx, { actor: "ollie", action: "revoke", payload: { clientId: id, name: client.name } });
    return row;
  });
}

/**
 * Reconnect: lifts the revoke. The Capture sweep's key works again straight away; an OAuth tool
 * has to go through the consent screen again, because its tokens stay revoked.
 */
export async function reconnectClient(id: number): Promise<AiClient> {
  const client = await loadClient(id);
  if (!client.revokedAt) return client;
  return db.transaction(async (tx) => {
    const [row] = await tx.update(aiClientsTable).set({ revokedAt: null }).where(eq(aiClientsTable.id, id)).returning();
    await writeAudit(tx, { actor: "ollie", action: "reconnect", payload: { clientId: id, name: client.name } });
    return row;
  });
}

export interface SweepRunView {
  id: number;
  startedAt: Date;
  finishedAt: Date | null;
  itemsCreated: number;
  itemsNoise: number;
  itemsDuplicate: number;
  activityLogged: number;
  errors: string[];
}

export interface SweepStatus {
  keyConfigured: boolean;
  client: { id: number; name: string; lastUsedAt: Date | null; revokedAt: Date | null };
  cursor: Date | null;
  runs: SweepRunView[];
}

/** For Settings: key status, the cursor and the last 20 runs. */
export async function sweepStatus(): Promise<SweepStatus> {
  const client = await captureSweepClient();
  const [runs, cursor] = await Promise.all([
    db.select().from(sweepRunsTable).orderBy(desc(sweepRunsTable.startedAt)).limit(20),
    lastSweepFinishedAt(),
  ]);
  return {
    keyConfigured: ingestKeyConfigured(),
    client: { id: client.id, name: client.name, lastUsedAt: client.lastUsedAt, revokedAt: client.revokedAt },
    cursor,
    runs: runs.map((r) => ({
      id: r.id,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      itemsCreated: r.itemsCreated,
      itemsNoise: r.itemsNoise,
      itemsDuplicate: r.itemsDuplicate,
      activityLogged: r.activityLogged,
      errors: Array.isArray(r.errors) ? (r.errors as string[]) : [],
    })),
  };
}

/** Marks the sweep client as used (calls that write rather than read). */
export async function touchClient(id: number): Promise<void> {
  await db.update(aiClientsTable).set({ lastUsedAt: sql`now()` }).where(eq(aiClientsTable.id, id));
}
