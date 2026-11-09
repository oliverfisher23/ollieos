import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { aiClientsTable, db, oauthTokensTable, sweepRunsTable } from "@workspace/db";
import { writeAudit } from "../lib/audit";
import { NotFoundError, ValidationError } from "./tasks";
import { listAiClients, type AiClientView } from "./access";

const ACTOR = "ollie";

async function loadClient(id: number) {
  const [row] = await db.select().from(aiClientsTable).where(eq(aiClientsTable.id, id));
  if (!row) throw new NotFoundError("That tool does not exist");
  if (row.auth === "internal") throw new ValidationError("Ask OllieOS is built in and cannot be revoked");
  return row;
}

async function view(id: number): Promise<AiClientView> {
  const found = (await listAiClients()).find((c) => c.id === id);
  if (!found) throw new NotFoundError("That tool does not exist");
  return found;
}

/** Cuts a tool off at once: its tokens stop working and the ingest key is refused while it is revoked. */
export async function revokeClient(id: number): Promise<AiClientView> {
  const client = await loadClient(id);
  if (!client.revokedAt) {
    await db.transaction(async (tx) => {
      const now = new Date();
      await tx.update(aiClientsTable).set({ revokedAt: now }).where(eq(aiClientsTable.id, id));
      await tx.update(oauthTokensTable).set({ revokedAt: now }).where(and(eq(oauthTokensTable.clientId, id), isNull(oauthTokensTable.revokedAt)));
      await writeAudit(tx, { actor: ACTOR, action: "revoke_client", payload: { aiClientId: id, name: client.name } });
    });
  }
  return view(id);
}

/**
 * Lets a revoked tool back in. The Capture sweep works again straight away; an OAuth tool such as
 * Claude has to go through the consent screen again, because its old tokens stay revoked.
 */
export async function reconnectClient(id: number): Promise<AiClientView & { needsSignIn: boolean }> {
  const client = await loadClient(id);
  if (client.revokedAt) {
    await db.transaction(async (tx) => {
      await tx.update(aiClientsTable).set({ revokedAt: null, connectedAt: new Date() }).where(eq(aiClientsTable.id, id));
      await writeAudit(tx, { actor: ACTOR, action: "reconnect_client", payload: { aiClientId: id, name: client.name } });
    });
  }
  return { ...(await view(id)), needsSignIn: client.auth === "oauth" };
}

/* ---------- Capture sweep (Settings) ---------- */

export async function sweepOverview() {
  const [client] = await db
    .select()
    .from(aiClientsTable)
    .where(and(eq(aiClientsTable.auth, "api_key"), eq(aiClientsTable.kind, "scheduled_task")))
    .orderBy(aiClientsTable.id)
    .limit(1);
  const runs = await db.select().from(sweepRunsTable).orderBy(desc(sweepRunsTable.startedAt)).limit(30);
  const [ok] = await db
    .select({ finishedAt: sweepRunsTable.finishedAt })
    .from(sweepRunsTable)
    .where(and(isNotNull(sweepRunsTable.finishedAt), sql`jsonb_array_length(${sweepRunsTable.errors}) = 0`))
    .orderBy(desc(sweepRunsTable.finishedAt))
    .limit(1);
  return {
    keyConfigured: !!process.env.INBOX_API_KEY,
    client: client
      ? { id: client.id, name: client.name, connectedAt: client.connectedAt, lastUsedAt: client.lastUsedAt, revokedAt: client.revokedAt }
      : null,
    lastSuccessfulAt: ok?.finishedAt ?? null,
    runs: runs.map((r) => ({
      id: r.id,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      itemsCreated: r.itemsCreated,
      itemsNoise: r.itemsNoise,
      itemsDuplicate: r.itemsDuplicate,
      activityLogged: r.activityLogged,
      errors: r.errors,
    })),
  };
}
