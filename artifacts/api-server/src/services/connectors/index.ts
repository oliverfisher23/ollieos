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
import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { appSettingsTable, calendarEventsTable, connectorRunsTable, db, peopleTable, tasksTable, type ConnectorRun } from "@workspace/db";
import { addDays, londonParts, londonWallTimeToInstant, todayLondon } from "@workspace/shared";
import { emailsOf } from "../personMatch";
import { logger } from "../../lib/logger";
import { replaceCalendar } from "../aiWrites";
import { scheduledWork } from "../scheduledWork";
import { NotFoundError, UpstreamError, ValidationError } from "../tasks";
import { sortAndCapture, type SortedRead } from "./capture";
import { readGmail } from "./gmail";
import { ConnectorError, readGoogleCalendar } from "./googleCalendar";
import { readDrive, type DriveState } from "./drive";
import { findGranolaNote, granolaRefFrom, readGranola, toMeetingNote, type GranolaState } from "./granola";
import { captureMeetings } from "./meetingCapture";
import { attachMeetingNotes } from "../briefs";
import { refreshNoReply } from "./noReply";
import { readSlack, type SlackState } from "./slack";
import { countReadable, DEFAULT_DROPBOX_STATE, forgetDropboxFiles, normaliseFolder, readDropbox, type DropboxState } from "./dropbox";
import { dropboxProgress, kickKnowledgeReader, type DropboxProgress } from "../documents/reader";

export const SERVICE_KEYS = ["calendar", "gmail", "slack", "drive", "granola", "dropbox"] as const;
export type ServiceKey = (typeof SERVICE_KEYS)[number];
export type ReadBy = "ollieos" | "claude";

/** Services OllieOS can read itself today. */
export const DIRECT_READY: ReadonlySet<ServiceKey> = new Set<ServiceKey>(["calendar", "gmail", "slack", "drive", "granola", "dropbox"]);

export const SERVICE_NAMES: Record<ServiceKey, string> = {
  calendar: "Google Calendar",
  gmail: "Gmail",
  slack: "Slack",
  drive: "Google Drive",
  granola: "Granola",
  dropbox: "Dropbox",
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
  /** Only what Ollie chose. A ready service he has not chosen for moves to OllieOS after its first good read (Granola: first read that found one of his meetings). */
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
export async function readByNow(key: ServiceKey, settings?: ConnectorSettings, good?: ConnectorRun | null): Promise<ReadBy> {
  if (!DIRECT_READY.has(key)) return "claude";
  // Claude never reads Dropbox for OllieOS, so there is nothing to hand over.
  if (key === "dropbox") return "ollieos";
  const s = settings ?? (await getConnectorSettings());
  const chosen = s.readBy[key];
  if (chosen) return chosen;
  // Granola needs historical proof of an own meeting, not just the latest good run.
  if (key !== "granola" && good !== undefined) return good ? "ollieos" : "claude";
  return (await provenRun(key)) ? "ollieos" : "claude";
}

/**
 * A good read that shows OllieOS can take over. For Granola that means it found at least one of
 * Ollie's own meetings: a key that only sees colleagues' notes must not switch Claude's feed off.
 */
async function provenRun(key: ServiceKey): Promise<boolean> {
  if (key !== "granola") return !!(await lastGoodRun(key));
  const [row] = await db
    .select({ id: connectorRunsTable.id })
    .from(connectorRunsTable)
    .where(and(eq(connectorRunsTable.connector, key), eq(connectorRunsTable.ok, true), sql`coalesce((${connectorRunsTable.counts}->>'meetings')::int, 0) > 0`))
    .limit(1);
  return !!row;
}

/** True when OllieOS reads this service itself, so Claude's copy must be refused. */
export async function refusesClaudeFeed(key: ServiceKey): Promise<boolean> {
  return (await readByNow(key)) === "ollieos";
}

/**
 * Which capture sources the Claude sweep may no longer send, because OllieOS reads them itself:
 * email while OllieOS reads Gmail, slack while it reads Slack, meeting while it reads Granola.
 */
export async function refusedClaudeSources(): Promise<Set<"email" | "slack" | "meeting">> {
  const s = await getConnectorSettings();
  const out = new Set<"email" | "slack" | "meeting">();
  if ((await readByNow("gmail", s)) === "ollieos") out.add("email");
  if ((await readByNow("slack", s)) === "ollieos") out.add("slack");
  if ((await readByNow("granola", s)) === "ollieos") out.add("meeting");
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
  // Part S: people who were in meetings together (meetings that have happened, in the last 2 days).
  let together = 0;
  try {
    const { recordTogether } = await import("../peopleSignals");
    const recent = await db
      .select()
      .from(calendarEventsTable)
      .where(and(eq(calendarEventsTable.personal, false), lt(calendarEventsTable.endsAt, now), gte(calendarEventsTable.endsAt, new Date(now.getTime() - 2 * 86_400_000))));
    for (const e of recent) if (e.personIds.length > 1) together += await recordTogether("meeting", e.sourceRef, e.title, e.startsAt, e.personIds, now);
  } catch (err) {
    logger.warn({ err }, "Could not record people in meetings together");
  }
  // Part R: meetings that ended go into the meeting history; the 12-week backfill runs once.
  let history = { recorded: 0, backfilled: 0 };
  try {
    const { historyFromCalendar } = await import("../timeAndMeetings");
    history = await historyFromCalendar(now);
  } catch (err) {
    logger.warn({ err }, "Could not update the meeting history");
  }
  return {
    found: r.found,
    account: r.account,
    counts: { kept: w.replaced, removed: w.removed, left_out: r.skipped, ...(together ? { relationships: together } : {}), ...(history.recorded ? { history: history.recorded } : {}), ...(history.backfilled ? { backfilled: history.backfilled } : {}) },
  };
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
  const c = await sortAndCapture(r.units, { me: `His email address is ${r.account}.`, now, agent: "gmail_sorter" });
  // Only move on once everything read has been captured, so a failed check is read again.
  await putState("gmail", { after: (r.newest ?? since).toISOString() });
  // Keeps No reply yet up to date; a problem there never fails the Gmail check.
  let noReply: Record<string, number> = {};
  try {
    const n = await refreshNoReply(now);
    if (n) noReply = { no_reply_found: n.found, no_reply_checked: n.checked };
  } catch (err) {
    logger.warn({ err }, "No reply yet could not be brought up to date");
    noReply = { no_reply_failed: 1 };
  }
  // Drafts on the Email page that Ollie has since sent leave the list.
  try {
    const { checkSentDrafts } = await import("../email");
    const sent = await checkSentDrafts();
    if (sent) noReply.drafts_sent = sent;
  } catch (err) {
    logger.warn({ err }, "Could not check drafts for sent emails");
  }
  return { found: r.found, account: r.account, counts: { ...c, left_out: r.leftOut, more: r.more ? 1 : 0, ...noReply } };
}

async function readSlackRun(now: Date) {
  const saved = await getState<SlackState>("slack");
  const r = await readSlack(saved, now);
  let read: SortedRead | null = null;
  const c = await sortAndCapture(r.units, {
    me: `On Slack he is ${r.account}; his messages are marked "from Ollie".`,
    now,
    agent: "slack_sorter",
    onSorted: async (x) => void (read = x),
  });
  // Slack to answer (Part P) from the same read; saved before the cursor moves, so a failed check is read again.
  const { updateSlackToAnswer } = await import("../slackToAnswer");
  const t = await updateSlackToAnswer({ read, opened: r.opened ?? [], me: r.me ?? null, now });
  await putState("slack", r.state);
  return { found: r.found, account: r.account, counts: { ...c, left_out: r.leftOut, conversations: r.checked, to_answer: t.waiting, answered: t.closed } };
}

async function readDriveRun(now: Date) {
  const r = await readDrive(await getState<DriveState>("drive"), now, await myAddresses());
  await putState("drive", r.state);
  return { found: r.found, account: r.account, counts: { ...r.counts } };
}

/**
 * Ollie's own addresses, so Granola notes from meetings he was in can be told apart from
 * colleagues' notes: the accounts Calendar and Gmail last read, and the address he signs in with.
 */
export async function myAddresses(): Promise<Set<string>> {
  const out = new Set<string>();
  for (const key of ["calendar", "gmail"] as const) {
    const a = (await lastGoodRun(key))?.account;
    if (a && a.includes("@")) out.add(a.trim().toLowerCase());
  }
  const allowed = process.env.ALLOWED_EMAIL;
  for (const a of (allowed ?? "").split(",")) if (a.includes("@")) out.add(a.trim().toLowerCase());
  // Every address on Ollie's own person record counts as him (Part N).
  const [self] = await db.select({ email: peopleTable.email, otherEmails: peopleTable.otherEmails }).from(peopleTable).where(eq(peopleTable.isSelf, true));
  if (self) for (const e of emailsOf(self)) out.add(e);
  return out;
}

async function readGranolaRun(now: Date) {
  const me = await myAddresses();
  if (!me.size) throw new ConnectorError("OllieOS does not know your email address yet. Check Google Calendar first.");
  const r = await readGranola(await getState<GranolaState>("granola"), me, now);
  const c = await captureMeetings(r.notes, { me: `His email address is ${[...me][0]}.`, now, myEmails: me });
  await putState("granola", r.state);
  return { found: r.found, account: null, counts: { ...c, meetings: r.notes.length, left_out: r.leftOut, more: r.more ? 1 : 0 } };
}

/**
 * Ollie links a Granola note to a meeting by hand, when it was not matched (Granola had no calendar
 * link, or the note was read before the meeting could hold it). A note OllieOS already read is only
 * attached, with the actions it made then; a new one is read in full against this meeting and
 * remembered, so the next check does not read it again. Moves the note off any other meeting.
 */
export async function linkGranolaNote(eventId: number, link: string, now = new Date()): Promise<void> {
  const [event] = await db.select().from(calendarEventsTable).where(eq(calendarEventsTable.id, eventId));
  if (!event || event.personal) throw new NotFoundError("That meeting is not on your calendar");
  const ref = granolaRefFrom(link);
  if (!ref) throw new ValidationError("That does not look like a Granola link. Paste the link from Granola's Share button or the note's address.");
  let raw;
  try {
    raw = await findGranolaNote(ref, event.startsAt);
  } catch (err) {
    throw new UpstreamError("Could not reach Granola just now. Try again in a moment.");
  }
  if (!raw) throw new NotFoundError("Granola has no note for that link that OllieOS can read. Check it is your note, or shared with you.");

  const me = await myAddresses();
  const note = toMeetingNote(raw, me);
  // Off any other meeting it was linked to.
  await db
    .update(calendarEventsTable)
    .set({ granolaRef: null, granolaUrl: null, granolaNotes: null, granolaTaskIds: [], granolaAttachedAt: null })
    .where(and(eq(calendarEventsTable.granolaRef, note.noteId), sql`${calendarEventsTable.id} <> ${event.id}`));

  const state = (await getState<GranolaState>("granola")) ?? { after: new Date(now.getTime() - 3 * 86_400_000).toISOString(), done: {} };
  if (state.done[note.noteId]) {
    const tasks = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(and(eq(tasksTable.source, "meeting"), sql`(${tasksTable.sourceRef} = ${"granola:" + note.noteId} or ${tasksTable.sourceRef} like ${"granola:" + note.noteId + "#%"})`));
    await attachMeetingNotes(event, { granolaRef: note.noteId, notes: note.notes, url: note.url, actionTaskIds: tasks.map((t) => t.id), actor: "ollie", clientId: null }, now);
    return;
  }
  await captureMeetings([note], { me: `His email address is ${[...me][0] ?? "unknown"}.`, now, myEmails: me, event });
  // Read again so a check that ran meanwhile is not undone.
  const latest = (await getState<GranolaState>("granola")) ?? state;
  await putState("granola", { ...latest, done: { ...latest.done, [note.noteId]: now.getTime() } });
}

async function readDropboxRun(now: Date) {
  const saved = { ...DEFAULT_DROPBOX_STATE, ...((await getState<DropboxState>("dropbox")) ?? {}) };
  // No folder chosen yet: nothing to read, and Dropbox is not asked.
  if (saved.folder == null) return { found: 0, account: null, counts: {} };
  const r = await readDropbox(saved, now);
  await putState("dropbox", r.state);
  if (r.counts.queued) kickKnowledgeReader();
  return { found: r.found, account: r.account, counts: { ...r.counts } };
}

export interface DropboxSetup extends DropboxState {
  progress: DropboxProgress;
}

export async function getDropboxSetup(): Promise<DropboxSetup> {
  const saved = { ...DEFAULT_DROPBOX_STATE, ...((await getState<DropboxState>("dropbox")) ?? {}) };
  return { ...saved, progress: await dropboxProgress() };
}

/**
 * Chooses Claude's folder in Dropbox. A different folder starts again: what OllieOS was keeping
 * track of is forgotten (what was approved from it stays), and the next check lists the new
 * folder, reading what is already there once when `existing` is "all".
 */
export async function setDropboxFolder(rawFolder: string, existing: "all" | "new"): Promise<DropboxSetup & { files: number; other: number }> {
  const folder = normaliseFolder(rawFolder);
  if (!folder) throw new ConnectorSettingsError("Choose a folder inside Dropbox, for example /Cowork/Springpod.");
  const found = await countReadable(folder);
  if (!found) throw new ConnectorSettingsError(`There is no folder called ${folder} in Dropbox.`);
  const saved = { ...DEFAULT_DROPBOX_STATE, ...((await getState<DropboxState>("dropbox")) ?? {}) };
  const same = saved.folder != null && saved.folder.toLowerCase() === folder.toLowerCase();
  if (!same) await forgetDropboxFiles();
  await putState("dropbox", { folder, existing, listed: same ? saved.listed : false } satisfies DropboxState);
  return { ...(await getDropboxSetup()), files: found.readable, other: found.other };
}

const READERS: Partial<Record<ServiceKey, (now: Date) => Promise<{ found: number; account: string | null; counts: Record<string, number> }>>> = {
  calendar: readCalendar,
  gmail: readGmailRun,
  slack: readSlackRun,
  drive: readDriveRun,
  granola: readGranolaRun,
  dropbox: readDropboxRun,
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

/** Message on a check that was cut off because the server restarted. */
export const STOPPED_BY_RESTART = "Stopped when OllieOS restarted, for example after publishing. The next check carries on.";

/** Closes checks left open by a restart, so they do not read as still running. */
export async function closeUnfinishedRuns(now = new Date()): Promise<number> {
  const closed = await db
    .update(connectorRunsTable)
    .set({ finishedAt: now, ok: false, error: STOPPED_BY_RESTART })
    .where(isNull(connectorRunsTable.finishedAt))
    .returning({ id: connectorRunsTable.id });
  return closed.length;
}

export function startConnectorTimer() {
  if (timer || process.env.NODE_ENV === "test" || process.env.OLLIEOS_CONNECTOR_TIMER === "off") return;
  // Nothing can be running yet in this server, so any open check was cut off by the restart.
  closeUnfinishedRuns().catch((err) => logger.error({ err }, "Could not close checks cut off by a restart"));
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
