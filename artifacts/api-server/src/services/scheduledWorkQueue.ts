/**
 * A durable, coalescing preparation request. The settings row survives restarts;
 * its token changes when more data arrives, retaining one follow-up during a pass.
 * No new schema is needed, and the worker runs independently of connector schedules.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { appSettingsTable, db, pool } from "@workspace/db";
import { logger } from "../lib/logger";
import { scheduledWork } from "./scheduledWork";

const KEY = "scheduled_work_pending";
const RETRY_MS = 60_000;

export async function enqueueScheduledWork(): Promise<void> {
  const value = { token: randomUUID() };
  await db.insert(appSettingsTable).values({ key: KEY, value })
    .onConflictDoUpdate({ target: appSettingsTable.key, set: {
      // A new check refreshes the token but must not bypass an existing retry delay.
      value: sql`${appSettingsTable.value} || ${JSON.stringify(value)}::jsonb`,
      updatedAt: new Date(),
    } });
  // Do not start any preparation until the request has had a chance to respond.
  if (process.env.NODE_ENV !== "test") setImmediate(() => { void drainScheduledWorkQueue(); });
}

let draining: Promise<void> | null = null;

/** One worker per server; the advisory lock also deduplicates across servers. */
export function drainScheduledWorkQueue(): Promise<void> {
  if (draining) return draining;
  draining = drain().catch((err) => {
    // Leave the durable request intact; startup or the next poll retries it.
    logger.error({ err }, "Queued scheduled work failed; it will retry");
  }).finally(() => { draining = null; });
  return draining;
}

async function drain(): Promise<void> {
  const client = await pool.connect();
  let locked = false;
  try {
    const result = await client.query<{ locked: boolean }>("select pg_try_advisory_lock(472091, 2) as locked");
    locked = result.rows[0].locked;
    if (!locked) return;
    for (;;) {
      const [pending] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, KEY));
      if (!pending) return;
      const retryAt = (pending.value as { retryAt?: number }).retryAt;
      if (retryAt && retryAt > Date.now()) return;
      let outcome: Record<string, unknown>;
      try {
        outcome = await scheduledWork("connectors");
      } catch (err) {
        await deferRetry();
        throw err;
      }
      const failedParts = Object.entries(outcome).filter(([, result]) => {
        if (!result || typeof result !== "object") return false;
        const part = result as { error?: unknown; failed?: number | boolean };
        return !!part.error || part.failed === true || (typeof part.failed === "number" && part.failed > 0);
      }).map(([name]) => name);
      if (failedParts.length) {
        await deferRetry();
        logger.warn({ parts: failedParts }, "Preparation parts failed; queued work will retry after a delay");
        return;
      }
      // A check finishing during this pass requests one more pass, not one per check.
      await db.delete(appSettingsTable).where(and(
        eq(appSettingsTable.key, KEY),
        sql`${appSettingsTable.value} = ${JSON.stringify(pending.value)}::jsonb`,
      ));
    }
  } finally {
    try {
      if (locked) await client.query("select pg_advisory_unlock(472091, 2)");
      client.release();
    } catch (err) {
      client.release(true);
      logger.error({ err }, "Could not release scheduled work queue lock");
    }
  }
}

async function deferRetry(): Promise<void> {
  // Merge into the latest value so a token written during the failed pass is retained.
  await db.update(appSettingsTable).set({
    value: sql`${appSettingsTable.value} || ${JSON.stringify({ retryAt: Date.now() + RETRY_MS })}::jsonb`,
    updatedAt: new Date(),
  }).where(eq(appSettingsTable.key, KEY));
}

let poll: NodeJS.Timeout | null = null;

export function startScheduledWorkQueue(): void {
  if (process.env.NODE_ENV === "test" || poll) return;
  void drainScheduledWorkQueue();
  poll = setInterval(() => { void drainScheduledWorkQueue(); }, 60_000);
  poll.unref();
}
