/**
 * Slack to answer (build plan section 19, Part P): Slack conversations whose newest message is from
 * someone else and waits on Ollie, shown as a tab on the Email page.
 *
 * Kept up to date by the Slack check, from the same read that sorts Slack into tasks (no extra AI
 * call): a newer message from someone else replaces a conversation's row, and a message from Ollie
 * after it closes it. Channel mentions are also closed when Ollie answers in their thread. Done
 * hides a row until a newer message arrives. A newest message that needs nothing from Ollie (thanks,
 * "ok", an emoji; by the AI's reading or by isAcknowledgement) closes the row instead of listing it.
 * Nothing is ever posted to Slack: a drafted reply is only copied.
 *
 * Between checks, opening Messages looks again at the conversations listed (one Slack call each) and
 * closes those Ollie has answered. A drafted reply is kept on its row until then. Later hides a row
 * until a day, or a newer message. Rows one of Ollie's noise rules covers are left out.
 *
 * The other way round: a direct message or group DM where Ollie wrote last and asked for something
 * goes on Waiting for a reply (review_items, kind no_reply, source_ref slack:...), and is closed as
 * answered when someone else writes there.
 */
import { and, desc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { db, noiseRulesTable, peopleTable, reviewItemsTable, slackToAnswerTable, tasksTable, type NoiseRule, type SlackToAnswer } from "@workspace/db";
import { OPEN_STATUSES, formatLong, formatTime, londonDate, toRef, todayLondon, weekday } from "@workspace/shared";
import { applicableRuleRefs, loadVisibleDocs } from "../lib/ai-data/retrieve";
import { recordReads, visibleRefs } from "../lib/ai-data/scope";
import { writeAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { captureTask, matchNoiseRule } from "./aiWrites";
import { askScope } from "./ask/ask";
import { draftSlackReplyFromDocs } from "./ask/model";
import { personIn, senderOf, type SortedRead } from "./connectors/capture";
import { lastGoodRun, readByNow } from "./connectors";
import { expectedByDate } from "./connectors/noReply";
import { recentSlackMessages, repliedInThread, slackMe, wroteSince, type SlackOpened } from "./connectors/slack";
import { sendersFor } from "./messagePriority";
import { ConflictError, NotFoundError, UpstreamError, ValidationError, updateTask } from "./tasks";
import { writingStyleNote } from "./writingStyle";

/** Only messages from the last 14 days are listed (question 53). */
export const SLACK_WINDOW_DAYS = 14;
const TEXT_CHARS = 800;
/** Most channel mentions whose threads are looked at in one check */
const THREAD_CHECKS = 10;
const THREAD_GAP_MS = 1000;
const OPEN = new Set<string>(OPEN_STATUSES);

export type SlackNeeds = "reply" | "info" | "unknown";

export interface SlackToAnswerItem {
  id: number;
  kind: string;
  /** The other person for a DM, the names in a group DM, or "#channel" */
  place: string;
  fromName: string | null;
  personId: number | null;
  personSlug: string | null;
  text: string;
  at: Date;
  url: string;
  needs: SlackNeeds;
  ask: string | null;
  /** Someone in it is hidden from AI, so it was not read for an ask and cannot be drafted */
  hidden: boolean;
  /** The open task for it, when there is one */
  taskId: number | null;
  /** The reply drafted for it, when there is one: it is on Drafts, not To answer */
  draft: SlackDraft | null;
  /** Later: the day it comes back, while it is hidden */
  snoozedUntil: string | null;
  /** Why it comes first ("Client", "Overdue to contact") */
  priority: string | null;
}

export interface SlackDraft {
  text: string;
  /** What Ollie asked it to say */
  brief: string | null;
  updatedAt: Date;
}

export interface SlackToAnswerView {
  items: SlackToAnswerItem[];
  /** The conversations listed are being looked at again */
  updating: boolean;
  /** Who reads Slack: only OllieOS's own Slack check fills this list */
  readBy: "ollieos" | "claude";
  /** When the last good Slack check finished */
  checkedAt: Date | null;
}

const tsOf = (ref: string) => ref.split(":").pop()!.split("#")[0];
const refOf = (r: Pick<SlackToAnswer, "conversationId" | "messageTs">) => `slack:${r.conversationId}:${r.messageTs}`;
const windowStart = (now: Date) => new Date(now.getTime() - SLACK_WINDOW_DAYS * 86_400_000);

/* ---------- Acknowledgements ---------- */

/** Words that only acknowledge, longest first so "thank you so much" goes before "thank you". */
const ACK_PHRASES = [
  "thank you so much", "thanks so much", "thanks a lot", "many thanks", "thank you", "thank u", "thanks", "thx", "ty", "cheers", "ta",
  "appreciate it", "appreciated", "much appreciated", "sounds good", "sounds great", "no worries", "no problem", "np", "will do", "got it", "noted",
  "all good", "all sorted", "sorted", "that works", "works now", "working now", "great stuff", "nice one", "perfect", "great", "brilliant",
  "amazing", "awesome", "lovely", "fantastic", "excellent", "super", "fab", "legend", "nice", "cool", "ok", "okay", "kk", "yep", "yes", "yeah", "done", "of course",
].sort((a, b) => b.length - a.length);
/** Words that can sit beside an acknowledgement without asking anything. */
const ACK_FILLER = new Set(["ollie", "you", "so", "much", "very", "again", "for", "that", "this", "now", "it", "all", "a", "lot", "mate", "guys", "both", "and", "oh", "ah", "haha", "lol", "x", "xx", "really", "just", "the", "help"]);
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const ACK_RE = new RegExp(`\\b(${ACK_PHRASES.map(escapeRe).join("|")})\\b`, "g");

/**
 * A short message that only thanks or acknowledges ("perfect thank you!", "working now thanks Ollie",
 * a thumbs up) and asks nothing, so needs no reply. Read without AI. Anything with a question mark,
 * or more than one word besides the acknowledgement (a name, say), is left to the AI's reading.
 */
export function isAcknowledgement(text: string): boolean {
  if (text.includes("?")) return false;
  let t = text.toLowerCase().replace(/<[@#!][^>]*>/g, " ");
  const emoji = /\p{Extended_Pictographic}|:[a-z0-9_+-]+:/u.test(t);
  t = t.replace(/:[a-z0-9_+-]+:/g, " ").replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}/gu, " ").replace(/[^\p{L}\p{N}'\s]/gu, " ").replace(/'/g, "");
  let found = emoji;
  t = t.replace(ACK_RE, () => {
    found = true;
    return " ";
  });
  const left = t.split(/\s+/).filter((w) => w && !ACK_FILLER.has(w));
  return found && left.length <= 1;
}

/* ---------- Kept up to date by the Slack check ---------- */

export interface SlackToAnswerUpdate {
  read: SortedRead | null;
  opened: SlackOpened[];
  /** Ollie's Slack user id, for looking at channel threads */
  me: string | null;
  now: Date;
}

export async function updateSlackToAnswer(u: SlackToAnswerUpdate): Promise<{ waiting: number; closed: number }> {
  const units = (u.read?.keep ?? []).map((unit, i) => ({ unit, i })).filter((x) => x.unit.conversation);
  const ids = [...new Set([...u.opened.map((o) => o.id), ...units.map((x) => x.unit.conversation!.id)])];
  if (!ids.length) return { waiting: 0, closed: await closeAnsweredThreads(u.me) };
  const rows = await db.select().from(slackToAnswerTable).where(inArray(slackToAnswerTable.conversationId, ids));
  const byConv = new Map(rows.map((r) => [r.conversationId, r]));
  let closed = 0;
  let waiting = 0;

  const close = async (convId: string, afterTs: string) => {
    const r = byConv.get(convId);
    if (!r || r.closedAt || r.messageTs >= afterTs) return;
    const now = new Date();
    await db.update(slackToAnswerTable).set({ closedAt: now, updatedAt: now, ...NO_DRAFT }).where(eq(slackToAnswerTable.id, r.id));
    byConv.set(convId, { ...r, closedAt: now });
    closed++;
  };

  // A message from Ollie anywhere in the conversation after the waiting one closes it.
  for (const o of u.opened) if (o.mineTs) await close(o.id, o.mineTs);

  for (const { unit, i } of units) {
    const conv = unit.conversation!;
    const last = unit.messages[unit.messages.length - 1];
    if (!last) continue;
    if (last.fromMe) {
      await close(conv.id, tsOf(last.ref));
      // Someone wrote before Ollie's newest message: what he asked earlier is answered.
      if (unit.messages.some((m) => !m.fromMe)) await closeAsked(conv.id, u.now);
      await noteAsked(u.read!, i, u.now);
      continue;
    }
    await closeAsked(conv.id, u.now);
    const ts = tsOf(last.ref);
    const cur = byConv.get(conv.id);
    if (cur && cur.messageTs >= ts) continue;
    const person = senderOf(u.read!.people, last);
    const hidden = !u.read!.readable[i] || (!!person && (person.confidential || !person.aiAccess));
    const reply = u.read!.sorted[i]?.reply;
    // Nothing needed from Ollie: the conversation is answered, so any older waiting message closes too.
    if ((!hidden && reply?.needs === "done") || isAcknowledgement(last.text)) {
      await close(conv.id, ts);
      continue;
    }
    const needs: SlackNeeds = !hidden && (reply?.needs === "reply" || reply?.needs === "info") ? reply.needs : "unknown";
    const values = {
      kind: conv.kind,
      place: unit.channel ?? "Slack",
      messageTs: ts,
      slackUserId: last.fromSlackId ?? null,
      fromName: last.fromName,
      personId: person?.id ?? null,
      text: last.text.slice(0, TEXT_CHARS),
      url: last.url,
      at: last.at,
      needs,
      ask: needs === "unknown" ? null : reply!.ask || null,
      why: hidden ? "hidden" : null,
      closedAt: null,
      updatedAt: new Date(),
    };
    if (cur) {
      await db.update(slackToAnswerTable).set(values).where(eq(slackToAnswerTable.id, cur.id));
      byConv.set(conv.id, { ...cur, ...values });
    } else {
      const [made] = await db.insert(slackToAnswerTable).values({ conversationId: conv.id, ...values }).onConflictDoNothing().returning();
      if (made) byConv.set(conv.id, made);
    }
    waiting++;
  }
  closed += await closeAnsweredThreads(u.me);
  return { waiting, closed };
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Channel mentions are often answered in their thread, which the Slack check does not read. Looks
 * at the threads of the newest open mentions (a few each check) and closes those Ollie answered.
 */
async function closeAnsweredThreads(me: string | null): Promise<number> {
  if (!me) return 0;
  const open = await db
    .select()
    .from(slackToAnswerTable)
    .where(
      and(
        eq(slackToAnswerTable.kind, "channel"),
        isNull(slackToAnswerTable.closedAt),
        sql`${slackToAnswerTable.at} >= ${windowStart(new Date()).toISOString()}::timestamptz`,
        or(isNull(slackToAnswerTable.doneTs), sql`${slackToAnswerTable.doneTs} <> ${slackToAnswerTable.messageTs}`),
      ),
    )
    .orderBy(desc(slackToAnswerTable.at))
    .limit(THREAD_CHECKS);
  let closed = 0;
  for (const [n, r] of open.entries()) {
    if (n > 0) await pause(THREAD_GAP_MS);
    try {
      if (await repliedInThread(r.conversationId, r.messageTs, me)) {
        await db.update(slackToAnswerTable).set({ closedAt: new Date(), updatedAt: new Date(), ...NO_DRAFT }).where(eq(slackToAnswerTable.id, r.id));
        closed++;
      }
    } catch (err) {
      logger.warn({ err, conversation: r.conversationId }, "Could not look at a Slack thread");
    }
  }
  return closed;
}

const NO_DRAFT = { draftText: null, draftBrief: null, draftAt: null } as const;

/* ---------- Waiting for a reply: Slack messages Ollie sent that asked for something ---------- */

const askedIn = (convId: string) =>
  and(eq(reviewItemsTable.kind, "no_reply"), eq(reviewItemsTable.state, "pending"), like(reviewItemsTable.sourceRef, `slack:${convId}:%`));

/** Someone else wrote in the conversation: what Ollie asked there is answered. */
async function closeAsked(convId: string, now: Date): Promise<void> {
  await db.update(reviewItemsTable).set({ state: "answered", decidedAt: now }).where(askedIn(convId));
}

/**
 * Ollie wrote last in a direct message or group DM and the sorter read it as expecting an answer:
 * onto Waiting for a reply, one per conversation. Never for a conversation AI may not read.
 */
async function noteAsked(read: SortedRead, i: number, now: Date): Promise<void> {
  const unit = read.keep[i];
  const conv = unit.conversation!;
  const reply = read.sorted[i]?.reply;
  if (conv.kind === "channel" || !read.readable[i] || reply?.needs !== "awaiting") return;
  const last = unit.messages[unit.messages.length - 1];
  // A thanks or "ok" asks for nothing, whatever the reading says.
  if (isAcknowledgement(last.text)) return;
  const others = unit.people.map((w) => personIn(read.people, w));
  if (others.some((p) => p && (p.confidential || !p.aiAccess))) return;
  const [open] = await db.select({ id: reviewItemsTable.id }).from(reviewItemsTable).where(askedIn(conv.id)).limit(1);
  if (open) return;
  const person = conv.kind === "im" ? (others[0] ?? null) : null;
  const who = unit.channel ?? "Slack";
  await db
    .insert(reviewItemsTable)
    .values({
      kind: "no_reply",
      sourceRef: last.ref,
      sourceUrl: last.url,
      meetingTitle: conv.kind === "im" ? `Slack message to ${who}` : `Slack group message to ${who}`,
      meetingAt: last.at,
      text: (reply.ask || `Reply from ${who} on Slack`).slice(0, 200),
      quote: last.text.slice(0, 300) || null,
      expectedBy: expectedByDate(last.at),
      suggestedType: "waiting",
      owner: person?.name ?? who,
      personId: person?.id ?? null,
    })
    .onConflictDoNothing();
  logger.info({ conversation: conv.id, at: now }, "Slack message added to Waiting for a reply");
}

/* ---------- Looking again between checks ---------- */

/** The list is looked at again once the last look is older than this */
const REFRESH_MS = 2 * 60_000;
/** Most conversations looked at in one go, newest first */
const REFRESH_MAX = 15;
let refreshedAt = 0;
let refreshing: Promise<number> | null = null;

/**
 * Looks at the conversations still listed, one Slack call each, and closes those Ollie has written
 * in since (or whose thread he answered, for a channel mention). New messages are left to the
 * Slack check, which reads them with AI.
 */
async function lookAgain(): Promise<number> {
  const rows = await db.select().from(slackToAnswerTable).where(waitingWhere(new Date())).orderBy(desc(slackToAnswerTable.at)).limit(REFRESH_MAX);
  if (!rows.length) return 0;
  const me = await slackMe();
  let closed = 0;
  for (const [n, r] of rows.entries()) {
    if (n > 0) await pause(THREAD_GAP_MS);
    try {
      const answered = (await wroteSince(r.conversationId, r.messageTs, me)) || (r.kind === "channel" && (await repliedInThread(r.conversationId, r.messageTs, me)));
      if (!answered) continue;
      await db.update(slackToAnswerTable).set({ closedAt: new Date(), updatedAt: new Date(), ...NO_DRAFT }).where(and(eq(slackToAnswerTable.id, r.id), eq(slackToAnswerTable.messageTs, r.messageTs)));
      closed++;
    } catch (err) {
      logger.warn({ err, conversation: r.conversationId }, "Could not look at a Slack conversation again");
    }
  }
  return closed;
}

/** Looks again now, once at a time. For Check now and the tests; the list does it in the background. */
export function refreshSlackToAnswer(): Promise<number> {
  refreshing ??= lookAgain()
    .catch((err) => {
      logger.warn({ err }, "Looking at Slack again failed");
      return 0;
    })
    .finally(() => {
      refreshedAt = Date.now();
      refreshing = null;
    });
  return refreshing;
}

/** For tests: waits for a background look to finish, and forgets when the last one was. */
export async function slackToAnswerIdle(): Promise<void> {
  while (refreshing) await refreshing;
  refreshedAt = 0;
}

/* ---------- The list ---------- */

/** True when one of Ollie's noise rules covers the row: a muted channel, say. */
const muted = (rules: NoiseRule[], r: Pick<SlackToAnswer, "place">) => !!matchNoiseRule(rules, { title: "", source: "slack", sourceChannel: r.place });

/** Later: hidden until its day, unless a newer message has arrived since. */
const snoozedNow = (r: Pick<SlackToAnswer, "snoozedUntil" | "snoozedTs" | "messageTs">, today: string) =>
  r.snoozedUntil != null && r.snoozedTs === r.messageTs && r.snoozedUntil > today;

/** Rows still waiting on Ollie: not closed, not Done for this message, from the last 14 days. */
function waitingWhere(now: Date) {
  return and(
    isNull(slackToAnswerTable.closedAt),
    sql`${slackToAnswerTable.at} >= ${windowStart(now).toISOString()}::timestamptz`,
    or(isNull(slackToAnswerTable.doneTs), sql`${slackToAnswerTable.doneTs} <> ${slackToAnswerTable.messageTs}`),
  );
}

/** Open tasks for these rows: the one Make a task made, else one the Slack check made from the same message. */
async function openTasks(rows: SlackToAnswer[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!rows.length) return out;
  const ids = rows.flatMap((r) => (r.taskId != null ? [r.taskId] : []));
  const refs = rows.map(refOf);
  const tasks = await db
    .select({ id: tasksTable.id, status: tasksTable.status, sourceRef: tasksTable.sourceRef })
    .from(tasksTable)
    .where(or(ids.length ? inArray(tasksTable.id, ids) : sql`false`, and(eq(tasksTable.source, "slack"), inArray(tasksTable.sourceRef, refs))));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const byRef = new Map(tasks.filter((t) => OPEN.has(t.status) && t.sourceRef).map((t) => [t.sourceRef!, t.id]));
  for (const r of rows) {
    const own = r.taskId != null ? byId.get(r.taskId) : undefined;
    const id = own && OPEN.has(own.status) ? own.id : byRef.get(refOf(r));
    if (id != null) out.set(r.id, id);
  }
  return out;
}

export async function listSlackToAnswer(now = new Date()): Promise<SlackToAnswerView> {
  const [all, readBy, run, rules] = await Promise.all([
    db.select().from(slackToAnswerTable).where(waitingWhere(now)).orderBy(desc(slackToAnswerTable.at)),
    readByNow("slack"),
    lastGoodRun("slack"),
    db.select().from(noiseRulesTable).where(eq(noiseRulesTable.enabled, true)),
  ]);
  // Rows kept before acknowledgements closed them, and rows a noise rule covers, are left out too.
  const rows = all.filter((r) => !isAcknowledgement(r.text) && !muted(rules, r));
  // Between Slack checks, look again at what is listed, in the background.
  if (readBy === "ollieos" && rows.length && !refreshing && Date.now() - refreshedAt > REFRESH_MS) void refreshSlackToAnswer();
  const today = todayLondon(now);
  const personIds = [...new Set(rows.flatMap((r) => (r.personId != null ? [r.personId] : [])))];
  const [people, tasks, senders] = await Promise.all([
    personIds.length
      ? db.select({ id: peopleTable.id, slug: peopleTable.slug, confidential: peopleTable.confidential, aiAccess: peopleTable.aiAccess }).from(peopleTable).where(inArray(peopleTable.id, personIds))
      : [],
    openTasks(rows),
    sendersFor([], personIds),
  ]);
  const byPerson = new Map(people.map((p) => [p.id, p]));
  const items = rows.map((r): SlackToAnswerItem => {
    const p = r.personId != null ? byPerson.get(r.personId) : undefined;
    const hidden = r.why === "hidden" || (!!p && (p.confidential || !p.aiAccess));
    return {
      id: r.id,
      kind: r.kind,
      place: r.place,
      fromName: r.fromName,
      personId: r.personId,
      personSlug: p?.slug ?? null,
      text: r.text,
      at: r.at,
      url: r.url,
      needs: hidden ? "unknown" : (r.needs as SlackNeeds),
      ask: hidden ? null : r.ask,
      hidden,
      taskId: tasks.get(r.id) ?? null,
      draft: r.draftText != null ? { text: r.draftText, brief: r.draftBrief, updatedAt: r.draftAt ?? r.updatedAt } : null,
      snoozedUntil: snoozedNow(r, today) ? r.snoozedUntil : null,
      priority: r.personId != null ? (senders.byPersonId.get(r.personId)?.priority ?? null) : null,
    };
  });
  return { items, updating: !!refreshing, readBy, checkedAt: run?.finishedAt ?? null };
}

/** The same working-day hour one working day back: a Monday morning looks back to Friday morning. */
export function oneWorkingDayBefore(now: Date): Date {
  let t = new Date(now.getTime() - 86_400_000);
  while ([0, 6].includes(weekday(londonDate(t)))) t = new Date(t.getTime() - 86_400_000);
  return t;
}

/** For the digest and Home: messages that need a reply and have waited over one working day. */
export async function slackRepliesOverdue(now = new Date()): Promise<number> {
  const cutoff = oneWorkingDayBefore(now);
  return (await slackNeedingReply(now)).filter((r) => r.at <= cutoff).length;
}

/** Rows that count as Needs a reply on Messages: not for information, not snoozed, muted or already drafted. */
export async function slackNeedingReply(now = new Date()): Promise<SlackToAnswer[]> {
  const [rows, rules] = await Promise.all([
    db.select().from(slackToAnswerTable).where(waitingWhere(now)),
    db.select().from(noiseRulesTable).where(eq(noiseRulesTable.enabled, true)),
  ]);
  const today = todayLondon(now);
  // Not read by AI counts as needing a reply, as on the tab.
  return rows.filter((r) => r.needs !== "info" && r.draftText == null && !isAcknowledgement(r.text) && !muted(rules, r) && !snoozedNow(r, today));
}

/* ---------- Ollie's actions ---------- */

async function getRow(id: number): Promise<SlackToAnswer> {
  const [row] = await db.select().from(slackToAnswerTable).where(eq(slackToAnswerTable.id, id));
  if (!row) throw new NotFoundError("That Slack message is not on To answer");
  return row;
}

/** Done: off the list until a newer message arrives, and its open task marked done. */
export async function markSlackDone(id: number, actor: string): Promise<{ taskId: number | null; previousStatus: string | null }> {
  const row = await getRow(id);
  await db.update(slackToAnswerTable).set({ doneTs: row.messageTs, updatedAt: new Date() }).where(eq(slackToAnswerTable.id, id));
  const taskId = (await openTasks([row])).get(row.id) ?? null;
  let previousStatus: string | null = null;
  if (taskId != null) {
    const [t] = await db.select({ status: tasksTable.status }).from(tasksTable).where(eq(tasksTable.id, taskId));
    previousStatus = t?.status ?? null;
    await updateTask(taskId, { status: "done" }, actor);
  }
  await writeAudit(db, { actor, action: "slack_done", entityType: "task", entityId: taskId, payload: { slackToAnswer: id, conversation: row.conversationId, taskId } });
  return { taskId, previousStatus };
}

/** Done on several at once (Mark all done): each as markSlackDone, with what Undo needs. */
export async function markSlackDoneMany(ids: number[], actor: string): Promise<{ id: number; taskId: number | null; previousStatus: string | null }[]> {
  const out: { id: number; taskId: number | null; previousStatus: string | null }[] = [];
  for (const id of [...new Set(ids)]) out.push({ id, ...(await markSlackDone(id, actor)) });
  return out;
}

/** Undo for Done: back on the list, and its task back where it was. */
export async function undoSlackDone(id: number, taskId: number | null, previousStatus: string | null, actor: string): Promise<void> {
  const row = await getRow(id);
  await db.update(slackToAnswerTable).set({ doneTs: null, updatedAt: new Date() }).where(eq(slackToAnswerTable.id, id));
  if (taskId != null && previousStatus) await updateTask(taskId, { status: previousStatus as never }, actor);
  await writeAudit(db, { actor, action: "slack_undo_done", entityType: "task", entityId: taskId, payload: { slackToAnswer: id, conversation: row.conversationId } });
}

/** Make a task: "Reply to <name> on Slack", status Now, linked to the message. An open task already linked is used instead. */
export async function ensureSlackTask(id: number, actor: string): Promise<{ taskId: number }> {
  const row = await getRow(id);
  const open = (await openTasks([row])).get(row.id);
  if (open != null) return { taskId: open };
  const who = row.fromName ?? row.place;
  const r = await captureTask(
    { actor, clientId: null },
    {
      title: `Reply to ${who} on Slack`.slice(0, 200),
      status: "now",
      source: "slack",
      sourceRef: refOf(row),
      sourceUrl: row.url,
      sourceChannel: row.place,
      snippet: row.text.slice(0, 280),
      fromName: row.fromName,
      personId: row.personId,
      capturedAt: row.at,
    },
    { applyNoise: false, via: "slack_to_answer" },
  );
  if (r.taskId == null) throw new NotFoundError("The message could not be added to OllieOS");
  // The Slack check made a task from this message before and it was closed: open it again.
  if (r.outcome === "duplicate") await updateTask(r.taskId, { status: "now" }, actor);
  await db.update(slackToAnswerTable).set({ taskId: r.taskId, updatedAt: new Date() }).where(eq(slackToAnswerTable.id, id));
  return { taskId: r.taskId };
}

/** The conversation as it is now, oldest first; the saved message when Slack cannot be read. */
async function conversationOf(row: SlackToAnswer, limit: number, maxText?: number): Promise<{ fromSlack: boolean; messages: { fromName: string; fromOllie: boolean; at: Date; text: string }[] }> {
  try {
    // A channel mention: what led up to it. A direct message or group DM: up to now.
    const recent = await recentSlackMessages(row.conversationId, limit, { latest: row.kind === "channel" ? row.messageTs : undefined, maxText });
    const messages = recent.map((m) => ({ fromName: m.fromName, fromOllie: m.fromMe, at: m.at, text: m.text }));
    if (messages.some((m) => !m.fromOllie)) return { fromSlack: true, messages };
  } catch (err) {
    logger.warn({ err, conversation: row.conversationId }, "Could not read the Slack conversation");
  }
  return { fromSlack: false, messages: [{ fromName: row.fromName ?? "Someone", fromOllie: false, at: row.at, text: row.text }] };
}

/** The last few messages of the conversation, for reading on Messages. Read from Slack, not by AI. */
export async function slackConversation(id: number) {
  return conversationOf(await getRow(id), 10, 4000);
}

const draftOf = (r: SlackToAnswer): SlackDraft => ({ text: r.draftText ?? "", brief: r.draftBrief, updatedAt: r.draftAt ?? r.updatedAt });

/**
 * Draft a reply: written in Ollie's style from the conversation and what AI may see, and kept on
 * the row so it shows on Drafts. `brief` says what it should say; `change` asks for the draft it
 * has to be changed ("shorter"). For copying only.
 */
export async function draftSlackReply(id: number, actor: string, opts: { brief?: string | null; change?: string | null } = {}): Promise<SlackDraft> {
  const row = await getRow(id);
  const scope = await askScope();
  const personRef = row.personId != null ? toRef("person", row.personId) : null;
  if (row.why === "hidden" || (personRef && !(await visibleRefs(scope, [personRef])).has(personRef))) {
    throw new ConflictError("Someone in this conversation is hidden from AI, so OllieOS cannot draft this. Write it yourself or allow AI on their page.");
  }
  const brief = opts.brief?.trim() || row.draftBrief || null;
  const change = opts.change?.trim() || null;
  if (change && !row.draftText) throw new ValidationError("There is no draft to change yet");

  const convo = await conversationOf(row, 8);
  const messages = convo.messages.map((m) => ({ from: m.fromName, when: whenLabel(m.at), fromOllie: m.fromOllie, text: m.text }));

  const refs: string[] = [];
  if (personRef) {
    refs.push(personRef);
    const tasks = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(and(inArray(tasksTable.status, [...OPEN_STATUSES]), or(eq(tasksTable.personId, row.personId!), eq(tasksTable.waitingOnPersonId, row.personId!))))
      .orderBy(desc(tasksTable.updatedAt))
      .limit(10);
    refs.push(...tasks.map((t) => toRef("task", t.id)));
  }
  const items = await loadVisibleDocs(scope, refs);
  const rules = await loadVisibleDocs(scope, await applicableRuleRefs(scope, refs));
  const docs = [...rules, ...items];
  await recordReads(scope, docs.map((d) => d.ref), { via: "slack_reply_draft", slackToAnswer: id });

  let text: string;
  try {
    text = await draftSlackReplyFromDocs({ to: row.fromName ?? row.place, where: row.place, messages, docs, style: await writingStyleNote(), brief, change: change ? { current: row.draftText!, ask: change } : null });
  } catch (err) {
    logger.error({ err }, "Slack reply draft failed");
    throw new UpstreamError("The draft could not be written just now. Try again in a moment.");
  }
  if (!text) throw new UpstreamError("The draft came back empty. Try again in a moment.");
  const [saved] = await db.update(slackToAnswerTable).set({ draftText: text, draftBrief: brief, draftAt: new Date(), updatedAt: new Date() }).where(eq(slackToAnswerTable.id, id)).returning();
  await writeAudit(db, { actor, action: "draft", entityType: "person", entityId: row.personId, payload: { via: "slack_to_answer", slackToAnswer: id, briefed: !!brief, changed: !!change } });
  return draftOf(saved);
}

/** Ollie's own edits to the draft, or a draft he wrote himself. */
export async function saveSlackDraft(id: number, text: string): Promise<SlackDraft> {
  const row = await getRow(id);
  const [saved] = await db.update(slackToAnswerTable).set({ draftText: text, draftAt: new Date(), updatedAt: new Date() }).where(eq(slackToAnswerTable.id, row.id)).returning();
  return draftOf(saved);
}

/** Takes the draft off Drafts; the message goes back on To answer. */
export async function removeSlackDraft(id: number): Promise<void> {
  const row = await getRow(id);
  await db.update(slackToAnswerTable).set({ ...NO_DRAFT, updatedAt: new Date() }).where(eq(slackToAnswerTable.id, row.id));
}

/** Later: hides the message until a day, or until a newer message arrives. Null brings it back. */
export async function snoozeSlack(id: number, until: string | null, actor: string): Promise<void> {
  const row = await getRow(id);
  if (until != null && until <= todayLondon()) throw new ValidationError("Pick a day after today");
  await db
    .update(slackToAnswerTable)
    .set({ snoozedUntil: until, snoozedTs: until ? row.messageTs : null, updatedAt: new Date() })
    .where(eq(slackToAnswerTable.id, row.id));
  await writeAudit(db, { actor, action: until ? "slack_later" : "slack_back", entityType: "task", entityId: null, payload: { slackToAnswer: id, conversation: row.conversationId, until } });
}

function whenLabel(at: Date): string {
  return `${formatLong(londonDate(at))}, ${formatTime(at)}`;
}
