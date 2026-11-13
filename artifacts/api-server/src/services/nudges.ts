/**
 * Nudges (build plan section 30, Part F): three direct messages on Slack to Ollie himself, so OllieOS
 * reaches him without being opened. A morning message (today's plan, meetings not prepared, messages
 * to answer), one 15 minutes before a work meeting with a prep page, and one at the end of the working
 * day (what was done, what is still due, who is ready for a chase).
 *
 * They come from OllieOS's own Slack app (SLACK_BOT_TOKEN), not from the Slack connection OllieOS
 * reads with: that one is Ollie's own account, and Slack does not notify you of your own messages.
 * The app can only be given `chat:write`, so it can message Ollie and read nothing.
 *
 * Rules (agreed 13th November 2026): only ever to Ollie himself, never to anyone else on a timer; each
 * is off until he turns it on; nothing at weekends or on a day with nothing to say; tasks and meetings
 * hidden from AI are never named. No AI is used.
 */
import { and, asc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import { appSettingsTable, calendarEventsTable, db, tasksTable } from "@workspace/db";
import { formatTime, londonParts, londonRange, todayLondon, weekday } from "@workspace/shared";
import { askScope } from "./ask/ask";
import { visibleCalendarRows } from "../lib/ai-data/context";
import { logger } from "../lib/logger";
import { briefableIds, notPreppedIds } from "./briefs";
import { slackMe } from "./connectors/slack";
import { messageCounts } from "./messages";
import { getPlan, getWorkingHours, toMinutes } from "./planning";
import { digestTimeReached } from "./scheduledWork";
import { UpstreamError, ValidationError, taskLoad } from "./tasks";
import type { TaskView } from "./taskView";

const SETTINGS_KEY = "nudges";
const SENT_KEY = "nudges_sent";

export interface NudgeSettings {
  morning: boolean;
  meeting: boolean;
  evening: boolean;
}
const OFF: NudgeSettings = { morning: false, meeting: false, evening: false };

interface Saved extends Partial<NudgeSettings> {
  /** The app's own address, kept from the last time Settings was saved in a browser, for links in messages */
  origin?: string;
  /** Ollie's Slack user id, looked up once through the Slack connection */
  slackUserId?: string;
}

interface Sent {
  date: string;
  morning?: boolean;
  evening?: boolean;
  meetings?: number[];
}

/** Minutes before a meeting starts that its nudge goes out. The timer ticks every minute, so a window, not an instant. */
export const MEETING_LEAD = { from: 16, to: 5 };
/** The morning message is not sent later than this; a server that was down all morning says nothing at noon. */
const MORNING_UNTIL = 11 * 60;
/** How long after the working day ends the evening message may still go. */
const EVENING_WINDOW = 90;

async function load<T>(key: string): Promise<T | null> {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, key));
  return row ? (row.value as T) : null;
}

async function save(key: string, value: unknown) {
  await db
    .insert(appSettingsTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettingsTable.key, set: { value, updatedAt: new Date() } });
}

export const botTokenSet = () => !!process.env.SLACK_BOT_TOKEN?.trim();

export async function getNudgeSettings() {
  const s = (await load<Saved>(SETTINGS_KEY)) ?? {};
  return { morning: !!s.morning, meeting: !!s.meeting, evening: !!s.evening, appConnected: botTokenSet() };
}

export async function setNudgeSettings(input: Partial<NudgeSettings>, origin?: string) {
  const s = (await load<Saved>(SETTINGS_KEY)) ?? {};
  const next: Saved = { ...OFF, ...s, ...input };
  if (origin) next.origin = origin;
  await save(SETTINGS_KEY, next);
  return getNudgeSettings();
}

/* ---------- Sending ---------- */

/** Posts one message as the OllieOS app. Tests stand this in. */
export type Send = (userId: string, text: string) => Promise<void>;

const slackSend: Send = async (userId, text) => {
  const token = process.env.SLACK_BOT_TOKEN?.trim();
  if (!token) throw new ValidationError("The OllieOS Slack app is not connected yet. Add its bot token as the SLACK_BOT_TOKEN secret.");
  let body: { ok?: boolean; error?: string };
  try {
    const res = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
      // A user id as the channel opens the app's own conversation with that person.
      body: JSON.stringify({ channel: userId, text, unfurl_links: false, unfurl_media: false }),
      signal: AbortSignal.timeout(15_000),
    });
    body = (await res.json()) as { ok?: boolean; error?: string };
  } catch (err) {
    throw new UpstreamError(`Slack could not be reached: ${err instanceof Error ? err.message : "unknown error"}`);
  }
  if (!body.ok) {
    const code = String(body.error ?? "unknown_error");
    if (/invalid_auth|not_authed|token_revoked|account_inactive/.test(code)) throw new UpstreamError(`Slack refused the OllieOS app's token (${code}). Check the SLACK_BOT_TOKEN secret.`);
    if (/missing_scope/.test(code)) throw new UpstreamError("The OllieOS Slack app needs the chat:write permission. Add it, reinstall the app and update the token.");
    throw new UpstreamError(`Slack did not send it: ${code}`);
  }
};

/** Ollie's Slack user id: asked of the Slack connection once, then kept. */
async function ollieSlackId(): Promise<string> {
  const s = (await load<Saved>(SETTINGS_KEY)) ?? {};
  if (s.slackUserId) return s.slackUserId;
  let id: string;
  try {
    id = await slackMe();
  } catch (err) {
    throw new UpstreamError(`Could not find your Slack account through the Slack connection: ${err instanceof Error ? err.message : "unknown error"}`);
  }
  if (!/^[UW][A-Z0-9]+$/.test(id)) throw new UpstreamError("The Slack connection did not say which account is yours.");
  await save(SETTINGS_KEY, { ...OFF, ...s, slackUserId: id });
  return id;
}

/* ---------- What each message says ---------- */

const link = (origin: string | undefined, path: string, label: string) => (origin ? `<${origin}${path}|${label}>` : label);
/** Slack reads &, < and > as markup. */
const plain = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);
const shown = (t: TaskView) => !t.hiddenFromAi && !t.confidential;

/** Titles Ollie lets AI see, then a count of the ones he does not: those are never named outside OllieOS. */
function titleLines(tasks: TaskView[], max: number): string[] {
  const open = tasks.filter(shown);
  const hidden = tasks.length - open.length;
  const lines = open.slice(0, max).map((t) => `• ${plain(t.title)}`);
  const more = open.length - Math.min(open.length, max) + hidden;
  if (more > 0) lines.push(`• and ${more} more`);
  return lines;
}

async function todaysEvents(now: Date) {
  const day = londonRange(todayLondon(now), 1);
  return db
    .select()
    .from(calendarEventsTable)
    .where(and(gte(calendarEventsTable.startsAt, day.start), lt(calendarEventsTable.startsAt, day.end)))
    .orderBy(asc(calendarEventsTable.startsAt));
}

export async function morningText(now: Date, origin?: string): Promise<string | null> {
  const [plan, events, counts] = await Promise.all([getPlan(now), todaysEvents(now), messageCounts(now).catch(() => null)]);
  const parts: string[] = [];

  const tasks = plan.made ? plan.items.filter((i) => i.task.status !== "done").map((i) => i.task) : plan.suggestions.slice(0, 5).map((s) => s.task);
  if (tasks.length) {
    const head = plan.made ? "*Today's plan*" : `*${count(tasks.length, "task", "tasks")} for today* (${link(origin, "/", "use this plan")})`;
    parts.push([head, ...titleLines(tasks, 5)].join("\n"));
  }

  const unprepped = await notPreppedIds(events, now);
  const work = events.filter((e) => !e.personal && e.startsAt > now);
  if (work.length) {
    const n = unprepped.size;
    parts.push(`*Meetings:* ${count(work.length, "still to come", "still to come")}${n ? `, ${count(n, "not prepared", "not prepared")}` : ""}. ${link(origin, "/meetings", "Open Meetings")}`);
  }

  if (counts && counts.needsReply > 0) {
    parts.push(`*To answer:* ${count(counts.needsReply, "message", "messages")}${counts.overdue ? `, ${counts.overdue} waiting over a working day` : ""}. ${link(origin, "/messages", "Open Messages")}`);
  }
  return parts.length ? parts.join("\n\n") : null;
}

/** Work meetings with a prep page that start inside the lead window and AI may see. */
export async function meetingsToNudge(now: Date, already: number[]) {
  const from = new Date(now.getTime() + MEETING_LEAD.to * 60_000);
  const to = new Date(now.getTime() + MEETING_LEAD.from * 60_000);
  const rows = await db
    .select()
    .from(calendarEventsTable)
    .where(and(gte(calendarEventsTable.startsAt, from), lte(calendarEventsTable.startsAt, to), eq(calendarEventsTable.personal, false)));
  const fresh = rows.filter((e) => !already.includes(e.id));
  if (!fresh.length) return [];
  const [briefable, visible, unprepped] = await Promise.all([
    briefableIds(fresh),
    askScope().then((scope) => visibleCalendarRows(scope, fresh)),
    notPreppedIds(fresh, now),
  ]);
  const seen = new Set(visible.rows.map((r) => r.id));
  return fresh.filter((e) => briefable.has(e.id) && seen.has(e.id)).map((e) => ({ event: e, notPrepped: unprepped.has(e.id) }));
}

export function meetingText(m: { event: { id: number; title: string; startsAt: Date }; notPrepped: boolean }, origin?: string): string {
  return `*${plain(m.event.title)}* starts at ${formatTime(m.event.startsAt)}.${m.notPrepped ? " You have not opened the prep page yet." : ""} ${link(origin, "/briefs/" + m.event.id, "Open the prep page")}`;
}

export async function eveningText(now: Date, origin?: string): Promise<string | null> {
  const today = todayLondon(now);
  const day = londonRange(today, 1);
  const [done, due, load] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(tasksTable)
      .where(and(eq(tasksTable.status, "done"), gte(tasksTable.completedAt, day.start), lt(tasksTable.completedAt, day.end))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(tasksTable)
      .where(and(inArray(tasksTable.status, ["now", "backlog", "inbox"]), lte(tasksTable.dueDate, today))),
    taskLoad(now),
  ]);
  const nDone = done[0]?.n ?? 0;
  const nDue = due[0]?.n ?? 0;
  if (!nDone && !nDue && !load.toChase) return null;
  const parts = [`*Today:* ${nDone ? `${count(nDone, "task", "tasks")} done` : "nothing ticked off"}.`];
  if (nDue) parts.push(`*Still due:* ${count(nDue, "task", "tasks")} due today or overdue. ${link(origin, "/tasks?due=overdue", "See what is overdue")}`);
  if (load.toChase) parts.push(`*Ready to chase:* ${count(load.toChase, "thing", "things")} you are waiting on. ${link(origin, "/tasks?tab=waiting", "Open Waiting on")}`);
  return parts.join("\n");
}

/* ---------- The timer ---------- */

export interface NudgeResult {
  sent: ("morning" | "meeting" | "evening")[];
}

/**
 * Called every minute by the connector timer. Sends whatever is due and has not gone today. A message
 * is marked as sent only after Slack accepts it, so a failure is tried again on the next tick; a
 * morning or evening with nothing to say is marked too, so it is not worked out every minute.
 */
export async function nudgeTick(now = new Date(), send: Send = slackSend): Promise<NudgeResult> {
  const out: NudgeResult = { sent: [] };
  const s = (await load<Saved>(SETTINGS_KEY)) ?? {};
  if (!s.morning && !s.meeting && !s.evening) return out;
  if (send === slackSend && !botTokenSet()) return out;
  const today = todayLondon(now);
  const wd = weekday(today);
  if (wd === 0 || wd === 6) return out;

  const saved = await load<Sent>(SENT_KEY);
  const sent: Sent = saved?.date === today ? saved : { date: today };
  const p = londonParts(now);
  const minute = p.hour * 60 + p.minute;
  let to: string | null = null;
  const deliver = async (text: string) => {
    to ??= await ollieSlackId();
    await send(to, text);
  };

  if (s.morning && !sent.morning && digestTimeReached(now) && minute < MORNING_UNTIL) {
    const text = await morningText(now, s.origin);
    if (text) {
      await deliver(text);
      out.sent.push("morning");
    }
    sent.morning = true;
    await save(SENT_KEY, sent);
  }

  if (s.meeting) {
    for (const m of await meetingsToNudge(now, sent.meetings ?? [])) {
      await deliver(meetingText(m, s.origin));
      out.sent.push("meeting");
      sent.meetings = [...(sent.meetings ?? []), m.event.id];
      await save(SENT_KEY, sent);
    }
  }

  const end = toMinutes((await getWorkingHours()).end);
  if (s.evening && !sent.evening && minute >= end && minute < end + EVENING_WINDOW) {
    const text = await eveningText(now, s.origin);
    if (text) {
      await deliver(text);
      out.sent.push("evening");
    }
    sent.evening = true;
    await save(SENT_KEY, sent);
  }
  return out;
}

/** "Send a test" in Settings: says plainly what went wrong when Slack refuses. */
export async function sendTestNudge(origin?: string, send: Send = slackSend): Promise<{ ok: true }> {
  if (origin) await setNudgeSettings({}, origin);
  const to = await ollieSlackId();
  await send(to, `This is OllieOS. Nudges will arrive here. ${link(origin, "/settings/planning", "Change which ones you get")}`);
  return { ok: true };
}

/** Never lets a nudge failure reach the connector timer. */
export async function nudgeTickSafely(now = new Date()): Promise<void> {
  try {
    const r = await nudgeTick(now);
    if (r.sent.length) logger.info({ sent: r.sent }, "Nudges sent");
  } catch (err) {
    logger.error({ err }, "Nudges failed; they will be tried again on the next tick");
  }
}
