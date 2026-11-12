/**
 * Slack to answer (build plan section 19, Part P): Slack conversations whose newest message is from
 * someone else and waits on Ollie, shown as a tab on the Email page.
 *
 * Kept up to date by the Slack check, from the same read that sorts Slack into tasks (no extra AI
 * call): a newer message from someone else replaces a conversation's row, and a message from Ollie
 * after it closes it. Channel mentions are also closed when Ollie answers in their thread. Done
 * hides a row until a newer message arrives. Nothing is ever posted to Slack: a drafted reply is
 * only copied.
 */
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db, peopleTable, slackToAnswerTable, tasksTable, type SlackToAnswer } from "@workspace/db";
import { OPEN_STATUSES, formatLong, formatTime, londonDate, toRef, weekday } from "@workspace/shared";
import { applicableRuleRefs, loadVisibleDocs } from "../lib/ai-data/retrieve";
import { recordReads, visibleRefs } from "../lib/ai-data/scope";
import { writeAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { captureTask } from "./aiWrites";
import { askScope } from "./ask/ask";
import { draftSlackReplyFromDocs } from "./ask/model";
import { senderOf, type SortedRead } from "./connectors/capture";
import { lastGoodRun, readByNow } from "./connectors";
import { recentSlackMessages, repliedInThread, type SlackOpened } from "./connectors/slack";
import { ConflictError, NotFoundError, UpstreamError, updateTask } from "./tasks";
import { writingStyleNote } from "./writingStyle";

/** Only messages from the last 14 days are listed (question 53). */
export const SLACK_WINDOW_DAYS = 14;
const TEXT_CHARS = 300;
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
}

export interface SlackToAnswerView {
  items: SlackToAnswerItem[];
  /** Who reads Slack: only OllieOS's own Slack check fills this list */
  readBy: "ollieos" | "claude";
  /** When the last good Slack check finished */
  checkedAt: Date | null;
}

const tsOf = (ref: string) => ref.split(":").pop()!.split("#")[0];
const refOf = (r: Pick<SlackToAnswer, "conversationId" | "messageTs">) => `slack:${r.conversationId}:${r.messageTs}`;
const windowStart = (now: Date) => new Date(now.getTime() - SLACK_WINDOW_DAYS * 86_400_000);

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
    await db.update(slackToAnswerTable).set({ closedAt: now, updatedAt: now }).where(eq(slackToAnswerTable.id, r.id));
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
      continue;
    }
    const ts = tsOf(last.ref);
    const cur = byConv.get(conv.id);
    if (cur && cur.messageTs >= ts) continue;
    const person = senderOf(u.read!.people, last);
    const hidden = !u.read!.readable[i] || (!!person && (person.confidential || !person.aiAccess));
    const reply = u.read!.sorted[i]?.reply;
    const needs: SlackNeeds = hidden || !reply || reply.needs === "none" ? "unknown" : reply.needs;
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
        await db.update(slackToAnswerTable).set({ closedAt: new Date(), updatedAt: new Date() }).where(eq(slackToAnswerTable.id, r.id));
        closed++;
      }
    } catch (err) {
      logger.warn({ err, conversation: r.conversationId }, "Could not look at a Slack thread");
    }
  }
  return closed;
}

/* ---------- The list ---------- */

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
  const [rows, readBy, run] = await Promise.all([
    db.select().from(slackToAnswerTable).where(waitingWhere(now)).orderBy(desc(slackToAnswerTable.at)),
    readByNow("slack"),
    lastGoodRun("slack"),
  ]);
  const personIds = [...new Set(rows.flatMap((r) => (r.personId != null ? [r.personId] : [])))];
  const [people, tasks] = await Promise.all([
    personIds.length
      ? db.select({ id: peopleTable.id, slug: peopleTable.slug, confidential: peopleTable.confidential, aiAccess: peopleTable.aiAccess }).from(peopleTable).where(inArray(peopleTable.id, personIds))
      : [],
    openTasks(rows),
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
    };
  });
  return { items, readBy, checkedAt: run?.finishedAt ?? null };
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
  const rows = await db
    .select({ id: slackToAnswerTable.id, needs: slackToAnswerTable.needs, at: slackToAnswerTable.at, why: slackToAnswerTable.why })
    .from(slackToAnswerTable)
    .where(waitingWhere(now));
  // Not read by AI counts as needing a reply, as on the tab.
  return rows.filter((r) => r.needs !== "info" && r.at <= cutoff).length;
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

/** Draft a reply: written in Ollie's style from the conversation and what AI may see, for copying only. */
export async function draftSlackReply(id: number, actor: string): Promise<{ text: string }> {
  const row = await getRow(id);
  const scope = await askScope();
  const personRef = row.personId != null ? toRef("person", row.personId) : null;
  if (row.why === "hidden" || (personRef && !(await visibleRefs(scope, [personRef])).has(personRef))) {
    throw new ConflictError("Someone in this conversation is hidden from AI, so OllieOS cannot draft this. Write it yourself or allow AI on their page.");
  }

  // The conversation as it is now; the saved message when Slack cannot be read.
  let messages: { from: string; when: string; fromOllie: boolean; text: string }[];
  try {
    const recent = await recentSlackMessages(row.conversationId, 8);
    messages = recent.map((m) => ({ from: m.fromName, when: whenLabel(m.at), fromOllie: m.fromMe, text: m.text }));
  } catch (err) {
    logger.warn({ err, conversation: row.conversationId }, "Could not read the Slack conversation for a draft");
    messages = [];
  }
  if (!messages.some((m) => !m.fromOllie)) messages.push({ from: row.fromName ?? "Someone", when: whenLabel(row.at), fromOllie: false, text: row.text });

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
    text = await draftSlackReplyFromDocs({ to: row.fromName ?? row.place, where: row.place, messages, docs, style: await writingStyleNote() });
  } catch (err) {
    logger.error({ err }, "Slack reply draft failed");
    throw new UpstreamError("The draft could not be written just now. Try again in a moment.");
  }
  if (!text) throw new UpstreamError("The draft came back empty. Try again in a moment.");
  await writeAudit(db, { actor, action: "draft", entityType: "person", entityId: row.personId, payload: { via: "slack_to_answer", slackToAnswer: id } });
  return { text };
}

function whenLabel(at: Date): string {
  return `${formatLong(londonDate(at))}, ${formatTime(at)}`;
}
