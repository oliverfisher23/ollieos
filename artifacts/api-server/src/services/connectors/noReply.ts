/**
 * No reply yet (Assist Part D): emails Ollie sent where he wrote last and nobody has answered.
 *
 * A one-off look through his sent mail for the last 6 months runs in the background, in chunks,
 * and can be stopped and resumed (the same way as the Granola look back). After it has finished,
 * every Gmail check keeps the list up to date: new unanswered emails appear once they are 3
 * working days old, and an item closes itself as answered when someone writes back.
 *
 * Before any AI sees a thread, it is left out when someone else wrote last, the thread had bulk or
 * mailing list mail in it, every recipient is an automated address, it is a calendar reply, Ollie
 * only wrote to himself, or his last message is a short thank-you. Haiku then checks each one
 * that is left for whether he asked for something or expected an answer, and why. Found ones wait
 * on the Email page, No reply yet (review_items, kind no_reply) for Chase, Already handled or Dropped.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import { appSettingsTable, db, peopleTable, reviewItemsTable, tasksTable } from "@workspace/db";
import { addDays, todayLondon, weekday } from "@workspace/shared";
import { logger } from "../../lib/logger";
import { ValidationError } from "../tasks";
import { projectChoices } from "./capture";
import { AUTOMATED, INVITE, gmailAccount, gmailThreadUrl, inPool, parseAddresses, readGmailThread, type Address } from "./gmail";
import { ConnectorError, proxyJson, proxyJsonOrNull } from "./http";
import { judgeNoReply, type NoReplyCandidate, type NoReplyVerdict } from "./noReplyJudge";

const CONNECTOR = "google-mail";
const NAME = "Gmail";
const STATE_KEY = "gmail_no_reply_scan";
/** What every look and refresh remembers: threads to look at again later, and emails already checked */
const MEMORY_KEY = "gmail_no_reply_memory";

/** How far back the look through sent mail goes */
export const SCAN_DAYS = 183;
/** An email counts as unanswered once this many working days have passed */
export const WAIT_WORKING_DAYS = 3;
/** Threads read per chunk; the run saves after each */
const CHUNK = 20;
/** A run that has not saved for this long is not running any more (the server restarted) */
const STALE_MS = 3 * 60_000;
/** Stop the run when this many chunks in a row could not be checked by AI */
const MAX_FAILS_IN_A_ROW = 3;
/** Emails checked longer ago than this are forgotten */
const FORGET_DAYS = 200;
/** How much of each message the AI reads */
const MESSAGE_CHARS = 2500;

export interface NoReplyCounts {
  /** Sent threads in range */
  threads: number;
  /** Threads someone else wrote last in */
  answered: number;
  /** Bulk, automated, calendar, to himself, or a thank-you */
  left_out: number;
  /** Sent too recently to check; no longer used, as sent email is checked straight away */
  recent: number;
  /** Already on the list, already checked, or already a Waiting on task */
  already: number;
  /** Emails AI checked */
  checked: number;
  /** Unanswered emails that expected an answer */
  found: number;
  /** Emails AI could not check; the next Gmail check tries again */
  failed: number;
}

const emptyCounts = (): NoReplyCounts => ({ threads: 0, answered: 0, left_out: 0, recent: 0, already: 0, checked: 0, found: 0, failed: 0 });

interface Saved {
  status: "running" | "stopped" | "done" | "failed";
  from: string;
  startedAt: string;
  finishedAt: string | null;
  heartbeat: string;
  listed: boolean;
  pageToken: string | null;
  queue: string[];
  position: number;
  counts: NoReplyCounts;
  error: string | null;
}

interface Memory {
  /** When the last refresh (or the look through) started; the next refresh reads changes since */
  refreshedAt: string | null;
  /** Thread id: when to look at it again (Ollie wrote last, but too recently) */
  watch: Record<string, string>;
  /** Ollie's message id: when AI checked it */
  judged: Record<string, string>;
}

export type NoReplyStatus = "idle" | "running" | "stopped" | "done" | "failed";

export interface NoReplyScanView {
  status: NoReplyStatus;
  /** True while the sent threads are still being listed */
  listing: boolean;
  days: number;
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  done: number;
  counts: NoReplyCounts;
  error: string | null;
  /** The last time a Gmail check brought the list up to date */
  refreshedAt: string | null;
  /** Unanswered emails waiting on the Email page, No reply yet */
  pending: number;
}

/* ---------- Saved state ---------- */

async function getSetting<T>(key: string): Promise<T | null> {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, key));
  return (row?.value as T | undefined) ?? null;
}

async function putSetting(key: string, value: unknown) {
  await db
    .insert(appSettingsTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: appSettingsTable.key, set: { value, updatedAt: new Date() } });
}

const save = (s: Saved) => putSetting(STATE_KEY, s);

async function loadMemory(): Promise<Memory> {
  const m = await getSetting<Partial<Memory>>(MEMORY_KEY);
  return { refreshedAt: m?.refreshedAt ?? null, watch: { ...(m?.watch ?? {}) }, judged: { ...(m?.judged ?? {}) } };
}

async function saveMemory(m: Memory, now: Date) {
  const cutoff = now.getTime() - FORGET_DAYS * 86_400_000;
  for (const [id, at] of Object.entries(m.judged)) if (new Date(at).getTime() < cutoff) delete m.judged[id];
  await putSetting(MEMORY_KEY, m);
}

/* ---------- Working days ---------- */

/** The moment `days` working days (Monday to Friday, London) after `at`. */
/** The London date a reply is expected by: the given number of working days after it was sent. */
export function expectedByDate(at: Date, days = WAIT_WORKING_DAYS): string {
  let date = todayLondon(at);
  let counted = 0;
  while (counted < days) {
    date = addDays(date, 1);
    const d = weekday(date);
    if (d !== 0 && d !== 6) counted++;
  }
  return date;
}

export function afterWorkingDays(at: Date, days = WAIT_WORKING_DAYS): Date {
  const start = todayLondon(at);
  let date = start;
  let counted = 0;
  let calendarDays = 0;
  while (counted < days) {
    date = addDays(date, 1);
    calendarDays++;
    const d = weekday(date);
    if (d !== 0 && d !== 6) counted++;
  }
  return new Date(at.getTime() + calendarDays * 86_400_000);
}

/* ---------- Reading Gmail ---------- */

export interface MetaMessage {
  id: string;
  at: Date;
  labels: Set<string>;
  from: Address;
  to: Address[];
  cc: Address[];
  subject: string | null;
  snippet: string;
  bulk: boolean;
  auto: boolean;
}

const HEADERS = ["From", "To", "Cc", "Subject", "List-Unsubscribe", "List-Id", "Precedence", "Auto-Submitted"];

interface RawMessage {
  id: string;
  labelIds?: string[];
  internalDate?: string;
  snippet?: string;
  payload?: { headers?: { name: string; value: string }[] };
}

/** One thread's messages with just their headers, oldest first, or null when the thread is gone. */
export async function threadMeta(threadId: string): Promise<MetaMessage[] | null> {
  const q = new URLSearchParams({ format: "metadata" });
  for (const h of HEADERS) q.append("metadataHeaders", h);
  const body = await proxyJsonOrNull(CONNECTOR, NAME, `/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?${q}`);
  if (!body) return null;
  return ((body.messages as RawMessage[] | undefined) ?? [])
    .map((m) => {
      const header = (name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value;
      const precedence = header("precedence")?.toLowerCase() ?? "";
      const auto = header("auto-submitted")?.toLowerCase() ?? "";
      return {
        id: m.id,
        at: new Date(Number(m.internalDate ?? 0)),
        labels: new Set(m.labelIds ?? []),
        from: parseAddresses(header("from"))[0] ?? { name: null, email: null },
        to: parseAddresses(header("to")),
        cc: parseAddresses(header("cc")),
        subject: header("subject")?.trim() || null,
        snippet: m.snippet ?? "",
        bulk: !!(header("list-unsubscribe") || header("list-id") || /bulk|list|junk/.test(precedence)),
        auto: !!auto && auto !== "no",
      };
    })
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** Thread ids matching a Gmail search, up to `pages` pages of 500. */
async function listThreads(q: string, pages = 2): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < pages; page++) {
    const p = new URLSearchParams({ q, maxResults: "500" });
    if (pageToken) p.set("pageToken", pageToken);
    const body = await proxyJson(CONNECTOR, NAME, "/gmail/v1/users/me/threads?" + p.toString());
    ids.push(...((body.threads as { id: string }[] | undefined) ?? []).map((t) => t.id));
    pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
    if (!pageToken) break;
  }
  return [...new Set(ids)];
}

const epoch = (d: Date) => Math.floor(d.getTime() / 1000);

/* ---------- Looking at one thread ---------- */

export type Look =
  | { kind: "gone" }
  | { kind: "answered" }
  | { kind: "left_out"; lastId: string; why: "bulk" | "automated" | "calendar" | "self" | "closed" }
  | { kind: "due"; last: MetaMessage; ids: string[] };

const CLOSING = /^(many thanks|thanks|thank you|thx|cheers|great|perfect|brilliant|lovely|amazing|ok|okay|sounds good|no worries|will do|noted|got it|appreciate it)\b[^?]{0,60}$/i;

/** The new text at the start of a snippet, before any quoted earlier message. */
function snippetHead(snippet: string): string {
  return snippet
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .split(/\bOn\s.{4,120}?wrote:/)[0]
    .trim();
}

/** Where a thread stands, from its headers alone. */
export function look(msgs: MetaMessage[] | null, me: Set<string>, _now: Date): Look {
  if (!msgs) return { kind: "gone" };
  const mine = (m: MetaMessage) => (m.from.email != null && me.has(m.from.email)) || m.labels.has("SENT");
  // Drafts never count; out-of-office and other automatic replies are not an answer.
  const real = msgs.filter((m) => !m.labels.has("DRAFT") && !m.labels.has("SPAM") && !m.labels.has("TRASH") && (mine(m) || !(m.auto || (m.from.email && AUTOMATED.test(m.from.email)))));
  if (!real.length) return { kind: "gone" };
  const last = real[real.length - 1];
  if (!mine(last)) return { kind: "answered" };
  if (real.some((m) => !mine(m) && m.bulk)) return { kind: "left_out", lastId: last.id, why: "bulk" };
  const subject = last.subject ?? real.find((m) => m.subject)?.subject ?? null;
  if (subject && INVITE.test(subject)) return { kind: "left_out", lastId: last.id, why: "calendar" };
  const others = [...last.to, ...last.cc].filter((a) => a.email && !me.has(a.email));
  if (!others.length) return { kind: "left_out", lastId: last.id, why: "self" };
  if (others.every((a) => AUTOMATED.test(a.email!))) return { kind: "left_out", lastId: last.id, why: "automated" };
  const head = snippetHead(last.snippet);
  if (head && head.length <= 80 && CLOSING.test(head)) return { kind: "left_out", lastId: last.id, why: "closed" };
  // Checked straight away: a sent email that asks for something is on the list from the start,
  // and turns due on the day a reply is expected by.
  return { kind: "due", last, ids: real.map((m) => m.id) };
}

/* ---------- Settling what was found ---------- */

interface Work {
  account: string;
  me: Set<string>;
  mem: Memory;
  counts: NoReplyCounts;
  now: Date;
  projects: { id: number; name: string }[];
}

interface Candidate {
  threadId: string;
  last: MetaMessage;
}

const refOf = (messageId: string) => `gmail:${messageId}`;

/** Closes or clears the open items for a thread that no longer fit. */
async function closeOpen(threadId: string, keepRef: string | null, how: "answered" | "superseded", now: Date) {
  const where = and(eq(reviewItemsTable.kind, "no_reply"), eq(reviewItemsTable.state, "pending"), eq(reviewItemsTable.threadId, threadId));
  if (how === "answered") {
    await db.update(reviewItemsTable).set({ state: "answered", decidedAt: now }).where(where);
  } else {
    // Ollie wrote again after the email on the list: the newer one is what counts now.
    await db.delete(reviewItemsTable).where(keepRef ? and(where, ne(reviewItemsTable.sourceRef, keepRef)) : where);
  }
}

/** True when an open Waiting on task already comes from this thread. */
async function alreadyWaiting(threadId: string, ids: string[]): Promise<boolean> {
  const refs = ids.map(refOf);
  const [row] = await db
    .select({ id: tasksTable.id })
    .from(tasksTable)
    .where(
      and(
        eq(tasksTable.status, "waiting"),
        sql`(${tasksTable.sourceUrl} like ${"%/" + threadId} or split_part(${tasksTable.sourceRef}, '#', 1) in (${sql.join(refs.map((r) => sql`${r}`), sql`, `)}))`,
      ),
    )
    .limit(1);
  return !!row;
}

/** Works out what to do with one thread, and returns it when AI needs to check it. */
async function settle(threadId: string, l: Look, w: Work): Promise<Candidate | null> {
  if (l.kind === "gone") {
    delete w.mem.watch[threadId];
    return null;
  }
  if (l.kind === "answered") {
    delete w.mem.watch[threadId];
    w.counts.answered++;
    await closeOpen(threadId, null, "answered", w.now);
    return null;
  }
  if (l.kind === "left_out") {
    delete w.mem.watch[threadId];
    w.counts.left_out++;
    await closeOpen(threadId, refOf(l.lastId), "superseded", w.now);
    return null;
  }
  delete w.mem.watch[threadId];
  const ref = refOf(l.last.id);
  await closeOpen(threadId, ref, "superseded", w.now);
  if (w.mem.judged[l.last.id]) {
    w.counts.already++;
    return null;
  }
  const [known] = await db.select({ id: reviewItemsTable.id }).from(reviewItemsTable).where(eq(reviewItemsTable.sourceRef, ref));
  if (known || (await alreadyWaiting(threadId, l.ids))) {
    w.mem.judged[l.last.id] = w.now.toISOString();
    w.counts.already++;
    return null;
  }
  return { threadId, last: l.last };
}

const named = (list: Address[], me: Set<string>) =>
  list.filter((a): a is { name: string | null; email: string } => !!a.email && !me.has(a.email));

/** Reads the candidates' threads, has AI check them, and puts the ones that expected an answer on No reply yet. */
async function checkCandidates(cands: Candidate[], w: Work): Promise<void> {
  if (!cands.length) return;
  const ready: { c: Candidate; input: NoReplyCandidate }[] = [];
  for (const [i, c] of cands.entries()) {
    const thread = await readGmailThread(c.threadId, MESSAGE_CHARS, w.account);
    const msgs = thread?.messages ?? [];
    const at = msgs.findIndex((m) => m.id === c.last.id);
    const mine = at >= 0 ? msgs[at] : null;
    if (!mine || !mine.text.trim()) {
      w.mem.judged[c.last.id] = w.now.toISOString();
      w.counts.left_out++;
      continue;
    }
    ready.push({
      c,
      input: {
        id: `t${i + 1}`,
        subject: mine.subject ?? c.last.subject,
        sentAt: mine.at,
        to: named(mine.to, w.me),
        cc: named(mine.cc, w.me),
        text: mine.text,
        earlier: msgs.slice(Math.max(0, at - 2), at).map((m) => ({
          from: [m.from.name, m.from.email].filter(Boolean).join(" ") || "someone",
          fromOllie: !!m.from.email && w.me.has(m.from.email),
          at: m.at,
          text: m.text.slice(0, 1200),
        })),
      },
    });
  }
  if (!ready.length) return;
  const verdicts = await judgeNoReply(
    ready.map((r) => r.input),
    { me: `His email addresses are ${[...w.me].join(", ")}.`, projects: w.projects.map((p) => p.name), now: w.now },
  );
  for (const [i, { c, input }] of ready.entries()) {
    const v = verdicts[i];
    w.counts.checked++;
    w.mem.judged[c.last.id] = w.now.toISOString();
    if (!v?.expectsReply) continue;
    if (await addItem(c, input, v, w)) w.counts.found++;
    else w.counts.already++;
  }
}

/** The recipient the verdict names, or the first person it was sent to. */
function recipientFor(v: NoReplyVerdict, input: NoReplyCandidate): { name: string | null; email: string } | null {
  const all = [...input.to, ...input.cc];
  const hint = v.person.toLowerCase().trim();
  if (hint) {
    const hit = all.find((a) => a.email === hint || (a.name && a.name.toLowerCase() === hint)) ?? all.find((a) => a.name && a.name.toLowerCase().startsWith(hint.split(/\s+/)[0] + " "));
    if (hit) return hit;
  }
  return input.to[0] ?? all[0] ?? null;
}

async function addItem(c: Candidate, input: NoReplyCandidate, v: NoReplyVerdict, w: Work): Promise<boolean> {
  const who = recipientFor(v, input);
  const cols = { id: peopleTable.id, name: peopleTable.name, confidential: peopleTable.confidential };
  let person: { id: number; name: string; confidential: boolean } | null = null;
  if (who) {
    [person = null] = await db
      .select(cols)
      .from(peopleTable)
      .where(and(eq(sql`lower(${peopleTable.email})`, who.email), eq(peopleTable.isSelf, false)))
      .limit(1);
    if (!person && who.name) {
      [person = null] = await db
        .select(cols)
        .from(peopleTable)
        .where(and(eq(sql`lower(${peopleTable.name})`, who.name.toLowerCase()), eq(peopleTable.isSelf, false)))
        .limit(1);
    }
  }
  const project = v.project ? (w.projects.find((p) => p.name.toLowerCase() === v.project.toLowerCase().trim()) ?? null) : null;
  const inserted = await db
    .insert(reviewItemsTable)
    .values({
      kind: "no_reply",
      sourceRef: refOf(c.last.id),
      sourceUrl: gmailThreadUrl(w.account, c.threadId),
      threadId: c.threadId,
      email: who?.email ?? null,
      meetingTitle: input.subject || "(no subject)",
      meetingAt: input.sentAt,
      text: v.ask.slice(0, 200),
      action: v.chase.trim() || null,
      quote: v.quote.trim() || null,
      reason: v.reason.trim() || null,
      expectedBy: expectedByDate(input.sentAt),
      suggestedType: "waiting",
      owner: person?.name ?? who?.name ?? who?.email ?? "Someone",
      personId: person?.id ?? null,
      projectId: project?.id ?? null,
      priority: v.priority,
      confidential: v.confidential || person?.confidential ? true : null,
    })
    .onConflictDoNothing()
    .returning({ id: reviewItemsTable.id });
  return inserted.length > 0;
}

/** Looks at a set of threads and settles each, then has AI check what is left. */
async function examine(threadIds: string[], w: Work): Promise<void> {
  const metas = await inPool(threadIds, 5, (id) => threadMeta(id));
  const cands: Candidate[] = [];
  for (const [i, id] of threadIds.entries()) {
    const c = await settle(id, look(metas[i], w.me, w.now), w);
    if (c) cands.push(c);
  }
  try {
    await checkCandidates(cands, w);
  } catch (err) {
    // Look at them again on the next Gmail check.
    for (const c of cands) if (!w.mem.judged[c.last.id]) w.mem.watch[c.threadId] = w.now.toISOString();
    w.counts.failed += cands.filter((c) => !w.mem.judged[c.last.id]).length;
    throw err;
  }
}

async function myself(): Promise<{ account: string; me: Set<string> }> {
  const { myAddresses } = await import("./index");
  const account = await gmailAccount();
  const me = await myAddresses();
  if (account) me.add(account);
  if (!me.size) throw new ConnectorError("OllieOS does not know your email address yet. Check Gmail first.");
  return { account, me };
}

/* ---------- The look through sent mail ---------- */

let active: { stop: boolean; done: Promise<void> } | null = null;
let refreshing = false;

/** Resolves when the look through in this server has finished or stopped. For tests. */
export async function waitForNoReplyScan(): Promise<void> {
  await active?.done;
}

async function pendingCount(): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reviewItemsTable)
    .where(and(eq(reviewItemsTable.kind, "no_reply"), eq(reviewItemsTable.state, "pending")));
  return r?.n ?? 0;
}

export async function getNoReplyScan(now = new Date()): Promise<NoReplyScanView> {
  const [s, mem, pending] = await Promise.all([getSetting<Saved>(STATE_KEY), loadMemory(), pendingCount()]);
  if (!s) {
    return { status: "idle", listing: false, days: SCAN_DAYS, startedAt: null, finishedAt: null, total: 0, done: 0, counts: emptyCounts(), error: null, refreshedAt: mem.refreshedAt, pending };
  }
  let status: NoReplyStatus = s.status;
  let error = s.error;
  if (status === "running" && !active && now.getTime() - new Date(s.heartbeat).getTime() > STALE_MS) {
    status = "stopped";
    error = "The look through stopped when OllieOS restarted. Resume to carry on from where it got to.";
  }
  return {
    status,
    listing: status === "running" && !s.listed,
    days: SCAN_DAYS,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    total: s.queue.length,
    done: s.position,
    counts: s.counts,
    error,
    refreshedAt: s.status === "running" ? null : mem.refreshedAt,
    pending,
  };
}

function busy(): never {
  throw new ValidationError("OllieOS is already looking through your sent email.");
}

export async function startNoReplyScan(now = new Date()): Promise<NoReplyScanView> {
  if (active || refreshing) busy();
  const s: Saved = {
    status: "running",
    from: new Date(now.getTime() - SCAN_DAYS * 86_400_000).toISOString(),
    startedAt: now.toISOString(),
    finishedAt: null,
    heartbeat: now.toISOString(),
    listed: false,
    pageToken: null,
    queue: [],
    position: 0,
    counts: emptyCounts(),
    error: null,
  };
  await save(s);
  // Gmail checks after the run pick up whatever changed from now on.
  const mem = await loadMemory();
  mem.refreshedAt = now.toISOString();
  await saveMemory(mem, now);
  launch(s);
  return getNoReplyScan(now);
}

export async function resumeNoReplyScan(now = new Date()): Promise<NoReplyScanView> {
  if (active || refreshing) busy();
  const s = await getSetting<Saved>(STATE_KEY);
  if (!s || s.status === "done") throw new ValidationError("There is nothing to resume. Start a new look through.");
  s.status = "running";
  s.error = null;
  s.finishedAt = null;
  s.heartbeat = now.toISOString();
  await save(s);
  launch(s);
  return getNoReplyScan(now);
}

export async function stopNoReplyScan(now = new Date()): Promise<NoReplyScanView> {
  if (active) {
    active.stop = true;
    await active.done;
  } else {
    const s = await getSetting<Saved>(STATE_KEY);
    if (s && s.status === "running") {
      s.status = "stopped";
      await save(s);
    }
  }
  return getNoReplyScan(now);
}

function launch(s: Saved) {
  const handle = { stop: false, done: Promise.resolve() };
  handle.done = scan(s, handle)
    .catch((err) => logger.error({ err }, "No reply look through failed"))
    .finally(() => {
      if (active === handle) active = null;
    });
  active = handle;
}

async function scan(s: Saved, handle: { stop: boolean }) {
  try {
    const { account, me } = await myself();
    while (!s.listed) {
      if (handle.stop) return await halt(s);
      const p = new URLSearchParams({ q: `in:sent after:${epoch(new Date(s.from))}`, maxResults: "500" });
      if (s.pageToken) p.set("pageToken", s.pageToken);
      const body = await proxyJson(CONNECTOR, NAME, "/gmail/v1/users/me/threads?" + p.toString());
      const seen = new Set(s.queue);
      for (const t of (body.threads as { id: string }[] | undefined) ?? []) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        s.queue.push(t.id);
      }
      s.counts.threads = s.queue.length;
      s.pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : null;
      s.listed = !s.pageToken;
      await beat(s);
    }

    const projects = await projectChoices();
    let failsInARow = 0;
    while (s.position < s.queue.length) {
      if (handle.stop) return await halt(s);
      const chunk = s.queue.slice(s.position, s.position + CHUNK);
      const w: Work = { account, me, mem: await loadMemory(), counts: s.counts, now: new Date(), projects };
      try {
        await examine(chunk, w);
        failsInARow = 0;
      } catch (err) {
        // The next Gmail check after the run looks at these threads again.
        for (const id of chunk) w.mem.watch[id] ??= w.now.toISOString();
        if (err instanceof ConnectorError && err.needsReconnect) {
          await saveMemory(w.mem, w.now);
          throw err;
        }
        logger.warn({ err }, "No reply look through could not check a chunk");
        if (++failsInARow >= MAX_FAILS_IN_A_ROW) {
          await saveMemory(w.mem, w.now);
          throw new ConnectorError("Several emails in a row could not be checked. Try resuming in a few minutes.");
        }
      }
      await saveMemory(w.mem, w.now);
      s.position += chunk.length;
      await beat(s);
    }
    s.status = "done";
    s.finishedAt = new Date().toISOString();
    await save(s);
  } catch (err) {
    if (!(err instanceof ConnectorError)) logger.error({ err }, "No reply look through stopped on an error");
    s.status = "failed";
    s.error = err instanceof ConnectorError ? err.message : "Something went wrong reading Gmail. Resume to try again.";
    await save(s);
  }
}

async function halt(s: Saved) {
  s.status = "stopped";
  await save(s);
}

async function beat(s: Saved) {
  s.heartbeat = new Date().toISOString();
  await save(s);
}

/* ---------- Keeping it up to date on each Gmail check ---------- */

/**
 * Brings the list up to date after a Gmail check, once the look through has finished: Ollie's
 * threads with new sent mail, threads on the list or waiting to be old enough that changed, and
 * waiting threads that are now old enough. Null when there is nothing to keep up to date yet.
 */
export async function refreshNoReply(now = new Date()): Promise<NoReplyCounts | null> {
  if (active || refreshing) return null;
  const s = await getSetting<Saved>(STATE_KEY);
  // Any time no look through is running: new sent email goes on the list without one.
  if (s?.status === "running" && Date.now() - new Date(s.heartbeat).getTime() <= STALE_MS) return null;
  refreshing = true;
  try {
    const { account, me } = await myself();
    const mem = await loadMemory();
    const since = mem.refreshedAt ? new Date(mem.refreshedAt) : new Date(now.getTime() - 86_400_000);
    const after = `after:${epoch(since) - 60}`;
    const pending = await db
      .select({ threadId: reviewItemsTable.threadId })
      .from(reviewItemsTable)
      .where(and(eq(reviewItemsTable.kind, "no_reply"), eq(reviewItemsTable.state, "pending")));
    const followed = new Set([...pending.map((p) => p.threadId!).filter(Boolean), ...Object.keys(mem.watch)]);
    const [sent, changed] = await Promise.all([listThreads(`in:sent ${after}`), followed.size ? listThreads(after) : Promise.resolve([] as string[])]);
    const due = Object.entries(mem.watch)
      .filter(([, at]) => new Date(at).getTime() <= now.getTime())
      .map(([id]) => id);
    const todo = [...new Set([...sent, ...changed.filter((id) => followed.has(id)), ...due])];
    const counts = emptyCounts();
    counts.threads = todo.length;
    const w: Work = { account, me, mem, counts, now, projects: await projectChoices() };
    let i = 0;
    try {
      for (; i < todo.length; i += CHUNK) await examine(todo.slice(i, i + CHUNK), w);
    } catch (err) {
      // Whatever was not looked at is looked at on the next check.
      for (const id of todo.slice(i)) mem.watch[id] ??= now.toISOString();
      throw err;
    } finally {
      mem.refreshedAt = now.toISOString();
      await saveMemory(mem, now);
    }
    return counts;
  } finally {
    refreshing = false;
  }
}
