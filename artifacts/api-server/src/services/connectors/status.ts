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
    dropbox: await getDropboxSetup(),
  };
}
