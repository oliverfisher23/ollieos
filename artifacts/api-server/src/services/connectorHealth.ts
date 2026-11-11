/**
 * Connector warnings (build plan section 19, Part Q): a service OllieOS reads that has stopped
 * working, or that works but has stopped bringing anything in. Worked out from the check history
 * each time it is asked for, so a warning clears on its own after the next good (or non-empty)
 * check. Shown under Needs you in the digest, on the Home status line and on the service's card.
 */
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { calendarEventsTable, connectorRunsTable, db, type ConnectorRun } from "@workspace/db";
import { formatLong, formatTime, londonDate, londonWallTimeToInstant, addDays, weekday } from "@workspace/shared";
import {
  DIRECT_READY,
  SERVICE_KEYS,
  SERVICE_NAMES,
  STOPPED_BY_RESTART,
  getConnectorSettings,
  readByNow,
  type Schedule,
  type ServiceKey,
} from "./connectors";
import { oneWorkingDayBefore } from "./slackToAnswer";

/** No good check for this long inside the working window (question 54)... */
export const FAILING_WINDOW_MS = 4 * 3600_000;
/** ...and at least this many failed checks in a row, whichever is later. */
export const FAILING_RUNS = 3;
/** Granola finding none of Ollie's meetings for this many working days, while his calendar had... */
const GRANOLA_EMPTY_DAYS = 2;
/** ...at least this many work meetings. */
const GRANOLA_MIN_MEETINGS = 3;
/** Gmail checks needed in the quiet working day before it counts as suspicious. */
const GMAIL_MIN_CHECKS = 3;

export interface ConnectorWarning {
  key: ServiceKey;
  name: string;
  /** failing: no good check; empty: checks work but bring nothing in */
  kind: "failing" | "empty";
  text: string;
}

/** Time inside the weekday checking window between two moments. */
export function windowMsBetween(from: Date, to: Date, schedule: Schedule): number {
  if (to <= from) return 0;
  const [sh, sm] = schedule.start.split(":").map(Number);
  const [eh, em] = schedule.end.split(":").map(Number);
  let total = 0;
  let date = londonDate(from);
  const last = londonDate(to);
  for (let i = 0; i < 60 && date <= last; i++, date = addDays(date, 1)) {
    if ([0, 6].includes(weekday(date))) continue;
    const ws = londonWallTimeToInstant(date, sh, sm).getTime();
    const we = londonWallTimeToInstant(date, eh, em).getTime();
    total += Math.max(0, Math.min(we, to.getTime()) - Math.max(ws, from.getTime()));
  }
  return total;
}

const at = (d: Date) => `${formatLong(londonDate(d))}, ${formatTime(d)}`;
const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

async function runsOf(key: ServiceKey, since: Date): Promise<ConnectorRun[]> {
  return db
    .select()
    .from(connectorRunsTable)
    .where(and(eq(connectorRunsTable.connector, key), gte(connectorRunsTable.startedAt, since)))
    .orderBy(desc(connectorRunsTable.startedAt));
}

/** No good check for 4 working hours and 3 failed checks in a row. */
export function failingWarning(key: ServiceKey, runs: ConnectorRun[], schedule: Schedule, now: Date): ConnectorWarning | null {
  // Newest first. A check stopped by a restart is neither good nor a failure.
  const finished = runs.filter((r) => r.finishedAt && r.error !== STOPPED_BY_RESTART);
  const lastGood = finished.find((r) => r.ok) ?? null;
  const failures = finished.filter((r) => !r.ok && (!lastGood || r.startedAt > lastGood.startedAt));
  if (failures.length < FAILING_RUNS) return null;
  const from = lastGood?.finishedAt ?? failures[failures.length - 1].startedAt;
  if (windowMsBetween(from, now, schedule) < FAILING_WINDOW_MS) return null;
  const error = failures[0].error ? ` Last error: ${sentence(failures[0].error)}` : "";
  const name = SERVICE_NAMES[key];
  return {
    key,
    name,
    kind: "failing",
    text: lastGood?.finishedAt ? `${name}: no good check since ${at(lastGood.finishedAt)}.${error}` : `${name}: no good check yet.${error}`,
  };
}

/** Granola works but has found none of Ollie's meetings for 2 working days while he had meetings. */
async function granolaEmpty(runs: ConnectorRun[], now: Date): Promise<ConnectorWarning | null> {
  let cutoff = now;
  for (let i = 0; i < GRANOLA_EMPTY_DAYS; i++) cutoff = oneWorkingDayBefore(cutoff);
  const good = runs.filter((r) => r.ok);
  // OllieOS must have been reading Granola for the whole stretch, so a new setup never warns.
  if (!good.some((r) => r.startedAt <= cutoff)) return null;
  const recent = good.filter((r) => r.startedAt > cutoff);
  if (!recent.length || recent.some((r) => (r.counts.meetings ?? 0) > 0)) return null;
  const meetings = await db
    .select({ id: calendarEventsTable.id })
    .from(calendarEventsTable)
    .where(and(eq(calendarEventsTable.personal, false), gte(calendarEventsTable.endsAt, cutoff), lte(calendarEventsTable.endsAt, now)));
  if (meetings.length < GRANOLA_MIN_MEETINGS) return null;
  return {
    key: "granola",
    name: SERVICE_NAMES.granola,
    kind: "empty",
    text: `Granola: checks are working, but none of your meetings since ${at(cutoff)} came through, though your calendar had ${meetings.length} work meetings. The Granola key may not see your own notes.`,
  };
}

/** Gmail works but has brought in no new email for a whole working day. */
function gmailEmpty(runs: ConnectorRun[], now: Date): ConnectorWarning | null {
  const cutoff = oneWorkingDayBefore(now);
  const good = runs.filter((r) => r.ok);
  if (!good.some((r) => r.startedAt <= cutoff)) return null;
  const recent = good.filter((r) => r.startedAt > cutoff);
  if (recent.length < GMAIL_MIN_CHECKS || recent.some((r) => r.found > 0)) return null;
  const lastFound = good.find((r) => r.found > 0);
  const since = lastFound?.finishedAt ?? cutoff;
  return {
    key: "gmail",
    name: SERVICE_NAMES.gmail,
    kind: "empty",
    text: `Gmail: checks are working, but no new email has come through since ${at(since)}.`,
  };
}

/** Every warning for services OllieOS reads now, in service order. */
export async function connectorWarnings(now = new Date()): Promise<ConnectorWarning[]> {
  const settings = await getConnectorSettings();
  const out: ConnectorWarning[] = [];
  // Check history is kept 30 days.
  const since = new Date(now.getTime() - 30 * 86_400_000);
  for (const key of SERVICE_KEYS) {
    if (!DIRECT_READY.has(key) || (await readByNow(key, settings)) !== "ollieos") continue;
    const runs = await runsOf(key, since);
    if (!runs.length) continue;
    const failing = failingWarning(key, runs, settings.schedule, now);
    if (failing) {
      out.push(failing);
      continue;
    }
    const empty = key === "granola" ? await granolaEmpty(runs, now) : key === "gmail" ? gmailEmpty(runs, now) : null;
    if (empty) out.push(empty);
  }
  return out;
}
