/** What the Connectors page shows: the schedule and one card per service. */
import { and, desc, eq, ne } from "drizzle-orm";
import { auditEventsTable, captureLogTable, db, type ConnectorRun } from "@workspace/db";
import {
  DIRECT_READY,
  SERVICE_KEYS,
  SERVICE_NAMES,
  getConnectorSettings,
  lastGoodRun,
  lastTimerRunAt,
  nextCheckAt,
  readByNow,
  recentRuns,
  type ReadBy,
  type Schedule,
  type ServiceKey,
} from "./index";

export interface RunView {
  id: number;
  trigger: string;
  startedAt: Date;
  finishedAt: Date | null;
  ok: boolean;
  found: number;
  counts: Record<string, number>;
  error: string | null;
}

export interface ServiceView {
  key: ServiceKey;
  name: string;
  readBy: ReadBy;
  /** True when Ollie picked who reads it; false when it follows the default. */
  chosen: boolean;
  canReadDirect: boolean;
  account: string | null;
  lastGoodAt: Date | null;
  lastFromClaudeAt: Date | null;
  runs: RunView[];
}

export interface ConnectorsView {
  schedule: Schedule & { lastRunAt: Date | null; nextRunAt: Date | null };
  services: ServiceView[];
}

const runView = (r: ConnectorRun): RunView => ({
  id: r.id,
  trigger: r.trigger,
  startedAt: r.startedAt,
  finishedAt: r.finishedAt,
  ok: r.ok,
  found: r.found,
  counts: r.counts,
  error: r.error,
});

/** Capture sources the Claude sweep writes for each service. */
const CLAUDE_SOURCE: Partial<Record<ServiceKey, "email" | "slack" | "meeting">> = { gmail: "email", slack: "slack", granola: "meeting" };

async function lastFromClaude(key: ServiceKey): Promise<Date | null> {
  if (key === "calendar") {
    const [row] = await db
      .select({ at: auditEventsTable.createdAt })
      .from(auditEventsTable)
      .where(and(eq(auditEventsTable.action, "sync"), eq(auditEventsTable.entityType, "calendar_event"), ne(auditEventsTable.actor, "ollieos")))
      .orderBy(desc(auditEventsTable.createdAt))
      .limit(1);
    return row?.at ?? null;
  }
  const source = CLAUDE_SOURCE[key];
  if (!source) return null;
  const [row] = await db
    .select({ at: captureLogTable.capturedAt })
    .from(captureLogTable)
    .where(eq(captureLogTable.source, source))
    .orderBy(desc(captureLogTable.capturedAt))
    .limit(1);
  return row?.at ?? null;
}

export async function connectorsView(now = new Date()): Promise<ConnectorsView> {
  const settings = await getConnectorSettings();
  const lastRunAt = await lastTimerRunAt();
  const services: ServiceView[] = [];
  for (const key of SERVICE_KEYS) {
    const runs = DIRECT_READY.has(key) ? await recentRuns(key, 6) : [];
    const good = DIRECT_READY.has(key) ? await lastGoodRun(key) : null;
    services.push({
      key,
      name: SERVICE_NAMES[key],
      readBy: await readByNow(key, settings),
      chosen: !!settings.readBy[key],
      canReadDirect: DIRECT_READY.has(key),
      account: good?.account ?? null,
      lastGoodAt: good?.finishedAt ?? null,
      lastFromClaudeAt: await lastFromClaude(key),
      runs: runs.map(runView),
    });
  }
  return {
    schedule: { ...settings.schedule, lastRunAt, nextRunAt: nextCheckAt(now, settings.schedule, lastRunAt) },
    services,
  };
}
