/**
 * Connectors: OllieOS reading Ollie's services itself, so it does not rely on the Claude sweep.
 *
 * Each service is read either by OllieOS or by Claude. Only services OllieOS can read are
 * switchable; the rest stay with the Claude sweep until their reader is built. A service OllieOS
 * reads is refused from Claude, so nothing arrives twice.
 *
 * The timer checks every minute whether a run is due (weekdays, inside the working window, at the
 * chosen interval). A run is claimed in the database first, so two server instances never run
 * the same check.
 */
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { appSettingsTable, connectorRunsTable, db, type ConnectorRun } from "@workspace/db";
import { addDays, londonParts, londonWallTimeToInstant, todayLondon } from "@workspace/shared";
import { logger } from "../../lib/logger";
import { replaceCalendar } from "../aiWrites";
import { scheduledWork } from "../scheduledWork";
import { ValidationError } from "../tasks";
import { sortAndCapture } from "./capture";
import { readGmail } from "./gmail";
import { ConnectorError, readGoogleCalendar } from "./googleCalendar";
import { readSlack, type SlackState } from "./slack";

export const SERVICE_KEYS = ["calendar", "gmail", "slack", "drive", "granola"] as const;
export type ServiceKey = (typeof SERVICE_KEYS)[number];
export type ReadBy = "ollieos" | "claude";

/** Services OllieOS can read itself today. */
export const DIRECT_READY: ReadonlySet<ServiceKey> = new Set<ServiceKey>(["calendar", "gmail", "slack"]);

export const SERVICE_NAMES: Record<ServiceKey, string> = {
  calendar: "Google Calendar",
  gmail: "Gmail",
  slack: "Slack",
  drive: "Google Drive",
  granola: "Granola",
};

export const INTERVALS = [30, 60] as const;

export interface Schedule {
  enabled: boolean;
  everyMinutes: (typeof INTERVALS)[number];
  /** "HH:MM", London time, weekdays only */
  start: string;
  end: string;
}

export interface ConnectorSettings {
  schedule: Schedule;
  /** Only what Ollie chose. A ready service he has not chosen for moves to OllieOS after its first good read. */
  readBy: Partial<Record<ServiceKey, ReadBy>>;
}

export const DEFAULT_SCHEDULE: Schedule = { enabled: true, everyMinutes: 30, start: "07:00", end: "19:00" };

const SETTINGS_KEY = "connectors";
const TICK_KEY = "connectors_last_timer_run";
const RUN_ACTOR = "ollieos";
const KEEP_RUNS_DAYS = 30;

/* ---------- Settings ---------- */

export async function getConnectorSettings(): Promise<ConnectorSettings> {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, SETTINGS_KEY));
  const saved = (row?.value ?? {}) as Partial<ConnectorSettings>;
  return { schedule: { ...DEFAULT_SCHEDULE, ...(saved.schedule ?? {}) }, readBy: { ...(saved.readBy ?? {}) } };
}

async function putConnectorSettings(s: ConnectorSettings) {
  await db
    .insert(appSettingsTable)
    .values({ key: SETTINGS_KEY, value: s })
    .onConflictDoUpdate({ target: appSettingsTable.key, set: { value: s, updatedAt: new Date() } });
}

export class ConnectorSettingsError extends ValidationError {}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const minutesOf = (hhmm: string) => {
  const m = HHMM.exec(hhmm)!;
  return Number(m[1]) * 60 + Number(m[2]);
};

export async function updateSchedule(patch: Partial<Schedule>): Promise<Schedule> {
  const s = await getConnectorSettings();
  const next = { ...s.schedule, ...patch };
  if (!HHMM.test(next.start) || !HHMM.test(next.end)) throw new ConnectorSettingsError("Times must be written as HH:MM, for example 07:00.");
  if (minutesOf(next.end) <= minutesOf(next.start)) throw new ConnectorSettingsError("The end time must be after the start time.");
  if (!INTERVALS.includes(next.everyMinutes)) throw new ConnectorSettingsError("Checks can run every 30 or 60 minutes.");
  s.schedule = next;
  await putConnectorSettings(s);
  return next;
}

export async function setReadBy(key: ServiceKey, readBy: ReadBy): Promise<void> {
  if (readBy === "ollieos" && !DIRECT_READY.has(key)) {
    throw new ConnectorSettingsError(`OllieOS cannot read ${SERVICE_NAMES[key]} yet, so Claude keeps reading it.`);
  }
  const s = await getConnectorSettings();
  s.readBy[key] = readBy;
  await putConnectorSettings(s);
}

export async function lastGoodRun(key: ServiceKey): Promise<ConnectorRun | null> {
  const [row] = await db
    .select()
    .from(connectorRunsTable)
    .where(and(eq(connectorRunsTable.connector, key), eq(connectorRunsTable.ok, true)))
    .orderBy(desc(connectorRunsTable.startedAt))
    .limit(1);
  return row ?? null;
}

/** Who reads a service now. */
export async function readByNow(key: ServiceKey, settings?: ConnectorSettings): Promise<ReadBy> {
  if (!DIRECT_READY.has(key)) return "claude";
  const s = settings ?? (await getConnectorSettings());
  const chosen = s.readBy[key];
  if (chosen) return chosen;
  return (await lastGoodRun(key)) ? "ollieos" : "claude";
}

/** True when OllieOS reads this service itself, so Claude's copy must be refused. */
export async function refusesClaudeFeed(key: ServiceKey): Promise<boolean> {
  return (await readByNow(key)) === "ollieos";
}

/**
 * Which capture sources the Claude sweep may no longer send, because OllieOS reads them itself:
 * email while OllieOS reads Gmail, slack while it reads Slack.
 */
export async function refusedClaudeSources(): Promise<Set<"email" | "slack">> {
  const s = await getConnectorSettings();
  const out = new Set<"email" | "slack">();
  if ((await readByNow("gmail", s)) === "ollieos") out.add("email");
  if ((await readByNow("slack", s)) === "ollieos") out.add("slack");
  return out;
}

/** Whether the timer should try this service: ready, and not handed back to Claude. */
function shouldRead(key: ServiceKey, s: ConnectorSettings): boolean {
  return DIRECT_READY.has(key) && s.readBy[key] !== "claude";
}

/* ---------- Running ---------- */

export interface RunOutcome {
  connector: ServiceKey;
  ok: boolean;
  found: number;
  counts: Record<string, number>;
  account: string | null;
  error: string | null;
  needsReconnect: boolean;
}

async function readCalendar(now: Date) {
  const r = await readGoogleCalendar(now);
  const w = await replaceCalendar({ actor: RUN_ACTOR, clientId: null }, r.events, now);
  return { found: r.found, account: r.account, counts: { kept: w.replaced, removed: w.removed, left_out: r.skipped } };
}

/* Where each reader got to, so the next check carries on from there. */

const stateKey = (key: ServiceKey) => `connector_state_${key}`;

async function getState<T>(key: ServiceKey): Promise<T | null> {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, stateKey(key)));
  return (row?.value as T | undefined) ?? null;
}

async function putState(key: ServiceKey, value: unknown) {
  await db
    .insert(appSettingsTable)
    .values({ key: stateKey(key), value })
    .onConflictDoUpdate({ target: appSettingsTable.key, set: { value, updatedAt: new Date() } });
}

/** The first check of a service looks back this far. */
const FIRST_LOOK_BACK_MS = 24 * 3600_000;

async function readGmailRun(now: Date) {
  const saved = await getState<{ after: string }>("gmail");
  const since = saved?.after ? new Date(saved.after) : new Date(now.getTime() - FIRST_LOOK_BACK_MS);
  const r = await readGmail(since);
  const c = await sortAndCapture(r.units, { me: `His email address is ${r.account}.`, now });
  // Only move on once everything read has been captured, so a failed check is read again.
  await putState("gmail", { after: (r.newest ?? since).toISOString() });
  return { found: r.found, account: r.account, counts: { ...c, left_out: r.leftOut, more: r.more ? 1 : 0 } };
}

async function readSlackRun(now: Date) {
  const saved = await getState<SlackState>("slack");
  const r = await readSlack(saved, now);
  const c = await sortAndCapture(r.units, { me: `On Slack he is ${r.account}; his messages are marked "from Ollie".`, now });
  await putState("slack", r.state);
  return { found: r.found, account: r.account, counts: { ...c, left_out: r.leftOut, conversations: r.checked } };
}

const READERS: Partial<Record<ServiceKey, (now: Date) => Promise<{ found: number; account: string | null; counts: Record<string, number> }>>> = {
  calendar: readCalendar,
  gmail: readGmailRun,
  slack: readSlackRun,
};

/** Services being read right now in this server, so a manual check and the timer never overlap. */
const running = new Set<ServiceKey>();

export async function runConnector(key: ServiceKey, trigger: "timer" | "manual", now = new Date()): Promise<RunOutcome> {
  const reader = READERS[key];
  if (!reader) throw new ConnectorSettingsError(`OllieOS cannot read ${SERVICE_NAMES[key]} yet.`);
  if (running.has(key)) {
    return { connector: key, ok: false, found: 0, counts: {}, account: null, error: `${SERVICE_NAMES[key]} is already being checked. Try again in a minute.`, needsReconnect: false };
  }
  running.add(key);
  try {
    return await runOnce(key, reader, trigger, now);
  } finally {
    running.delete(key);
  }
}

async function runOnce(key: ServiceKey, reader: NonNullable<(typeof READERS)[ServiceKey]>, trigger: "timer" | "manual", now: Date): Promise<RunOutcome> {
  const [run] = await db.insert(connectorRunsTable).values({ connector: key, trigger, startedAt: now }).returning({ id: connectorRunsTable.id });
  try {
    const r = await reader(now);
    await db
      .update(connectorRunsTable)
      .set({ finishedAt: new Date(), ok: true, found: r.found, counts: r.counts, account: r.account })
      .where(eq(connectorRunsTable.id, run.id));
    return { connector: key, ok: true, found: r.found, counts: r.counts, account: r.account, error: null, needsReconnect: false };
  } catch (err) {
    const needsReconnect = err instanceof ConnectorError && err.needsReconnect;
    const message = err instanceof ConnectorError ? err.message : "Something went wrong reading " + SERVICE_NAMES[key] + ".";
    if (!(err instanceof ConnectorError)) logger.error({ err, connector: key }, "Connector run failed");
    await db.update(connectorRunsTable).set({ finishedAt: new Date(), ok: false, error: message }).where(eq(connectorRunsTable.id, run.id));
    return { connector: key, ok: false, found: 0, counts: {}, account: null, error: message, needsReconnect };
  }
}

/** Reads every service OllieOS is in charge of, then runs the follow-on work (briefs, digest). */
export async function runAll(trigger: "timer" | "manual", now = new Date()) {
  const s = await getConnectorSettings();
  const runs: RunOutcome[] = [];
  for (const key of SERVICE_KEYS) if (shouldRead(key, s)) runs.push(await runConnector(key, trigger, now));
  const scheduled = await scheduledWork("connectors", now);
  await db.delete(connectorRunsTable).where(lt(connectorRunsTable.startedAt, new Date(now.getTime() - KEEP_RUNS_DAYS * 86_400_000)));
  return { runs, scheduled };
}

/* ---------- Timer ---------- */

const isWeekday = (date: string) => {
  const d = new Date(date + "T12:00:00Z").getUTCDay();
  return d !== 0 && d !== 6;
};

/** True when now is a weekday inside the working window. */
export function insideWindow(now: Date, schedule: Schedule): boolean {
  if (!isWeekday(todayLondon(now))) return false;
  const p = londonParts(now);
  const m = p.hour * 60 + p.minute;
  return m >= minutesOf(schedule.start) && m <= minutesOf(schedule.end);
}

/** When the next timed check will happen, or null when checks are off. */
export function nextCheckAt(now: Date, schedule: Schedule, lastRunAt: Date | null): Date | null {
  if (!schedule.enabled) return null;
  const every = schedule.everyMinutes * 60_000;
  const due = lastRunAt ? new Date(Math.max(lastRunAt.getTime() + every, now.getTime())) : now;
  if (insideWindow(due, schedule)) return due;
  // Otherwise the start of the next working window.
  let date = todayLondon(due);
  const [h, m] = schedule.start.split(":").map(Number);
  for (let i = 0; i < 8; i++) {
    const start = londonWallTimeToInstant(date, h, m);
    if (isWeekday(date) && start.getTime() >= due.getTime()) return start;
    date = addDays(date, 1);
  }
  return null;
}

/** Claims the timer run in the database so only one server instance runs it. */
async function claimTimerRun(now: Date, everyMinutes: number): Promise<boolean> {
  const before = new Date(now.getTime() - (everyMinutes - 2) * 60_000).toISOString();
  const value = JSON.stringify({ at: now.toISOString() });
  const res = await db.execute(sql`
    insert into app_settings (key, value, updated_at) values (${TICK_KEY}, ${value}::jsonb, now())
    on conflict (key) do update set value = excluded.value, updated_at = now()
    where (app_settings.value->>'at')::timestamptz <= ${before}::timestamptz
    returning key`);
  return res.rows.length > 0;
}

export async function lastTimerRunAt(): Promise<Date | null> {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, TICK_KEY));
  const at = (row?.value as { at?: string } | undefined)?.at;
  return at ? new Date(at) : null;
}

export async function timerTick(now = new Date()): Promise<boolean> {
  const s = await getConnectorSettings();
  if (!s.schedule.enabled || !insideWindow(now, s.schedule)) return false;
  if (!(await claimTimerRun(now, s.schedule.everyMinutes))) return false;
  const r = await runAll("timer", now);
  logger.info({ runs: r.runs.map((x) => ({ connector: x.connector, ok: x.ok, found: x.found })) }, "Connector check finished");
  return true;
}

let timer: NodeJS.Timeout | null = null;

export function startConnectorTimer() {
  if (timer || process.env.NODE_ENV === "test" || process.env.OLLIEOS_CONNECTOR_TIMER === "off") return;
  let busy = false;
  timer = setInterval(() => {
    if (busy) return;
    busy = true;
    timerTick()
      .catch((err) => logger.error({ err }, "Connector timer failed"))
      .finally(() => {
        busy = false;
      });
  }, 60_000);
  timer.unref();
  logger.info("Connector timer started");
}

/* ---------- Status for the Connectors page ---------- */

export async function recentRuns(key: ServiceKey, limit = 5): Promise<ConnectorRun[]> {
  return db
    .select()
    .from(connectorRunsTable)
    .where(eq(connectorRunsTable.connector, key))
    .orderBy(desc(connectorRunsTable.startedAt))
    .limit(limit);
}
