/** What the Connectors page shows: the schedule and one card per service. */
import { and, desc, eq, ne, notInArray } from "drizzle-orm";
import { auditEventsTable, db, tasksTable, type ConnectorRun } from "@workspace/db";
import {
  DIRECT_READY,
  SERVICE_KEYS,
  getDropboxSetup,
  type DropboxSetup,
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
  /** Claude's folder in Dropbox and how far reading it has got */
  dropbox: DropboxSetup;
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
  // OllieOS's own Gmail and Slack reads write tasks too; only count what Claude sent.
  const [row] = await db
    .select({ at: tasksTable.createdAt })
    .from(tasksTable)
    .where(and(eq(tasksTable.source, source), notInArray(tasksTable.createdBy, ["ollieos", "ollie"])))
    .orderBy(desc(tasksTable.createdAt))
    .limit(1);
  return row?.at ?? null;
}

export async function connectorsView(now = new Date()): Promise<ConnectorsView> {
  const settingsPromise = getConnectorSettings();
  // The fixed six-service list bounds concurrency and preserves card order.
  const servicesPromise = settingsPromise.then((settings) => Promise.all(SERVICE_KEYS.map(async (key): Promise<ServiceView> => {
    const [runs, good, lastFromClaudeAt, granolaReadBy] = await Promise.all([
      DIRECT_READY.has(key) ? recentRuns(key, 6) : [],
      DIRECT_READY.has(key) ? lastGoodRun(key) : null,
      lastFromClaude(key),
      key === "granola" ? readByNow(key, settings) : undefined,
    ]);
    return {
      key,
      name: SERVICE_NAMES[key],
      readBy: granolaReadBy ?? await readByNow(key, settings, good),
      chosen: !!settings.readBy[key],
      canReadDirect: DIRECT_READY.has(key),
      account: good?.account ?? null,
      lastGoodAt: good?.finishedAt ?? null,
      lastFromClaudeAt,
      runs: runs.map(runView),
    };
  })));
  const [settings, lastRunAt, dropbox, services] = await Promise.all([
    settingsPromise,
    lastTimerRunAt(),
    getDropboxSetup(),
    servicesPromise,
  ]);
  return {
    schedule: { ...settings.schedule, lastRunAt, nextRunAt: nextCheckAt(now, settings.schedule, lastRunAt) },
    services,
    dropbox,
  };
}
