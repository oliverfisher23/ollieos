/**
 * To answer on the Email page: Ollie's Gmail inbox, read or unread, where the last message is not
 * from him. An email leaves when he replies, when it leaves the Gmail inbox (archived in
 * Superhuman or Gmail), or when he marks it Done here (until a new message arrives). Newsletters
 * and automatic emails are left out. Read only: OllieOS cannot archive or label in Gmail.
 *
 * An email only becomes a task when Ollie acts on it (Brief a reply, Reply, Save to Library), so
 * reading the inbox adds nothing to Tasks. Emails the Gmail check already made a task for are
 * linked to it.
 */
import { and, eq, like } from "drizzle-orm";
import { appSettingsTable, db, tasksTable } from "@workspace/db";
import { writeAudit } from "../lib/audit";
import { captureTask } from "./aiWrites";
import { AUTOMATED, INVITE, gmailAccount, gmailThreadUrl, inPool } from "./connectors/gmail";
import { ConnectorError, proxyJson } from "./connectors/http";
import { threadMeta, type MetaMessage } from "./connectors/noReply";
import { NotFoundError, UpstreamError, ValidationError, updateTask } from "./tasks";

const CONNECTOR = "google-mail";
const NAME = "Gmail";
/** Most inbox emails listed */
export const INBOX_MAX = 200;
const DONE_KEY = "email_inbox_done";
const CLOSED = new Set(["done", "dropped", "noise", "archived"]);

export interface InboxItem {
  threadId: string;
  /** The newest message, the one waiting on Ollie */
  messageId: string;
  subject: string | null;
  fromName: string | null;
  fromEmail: string | null;
  at: Date;
  snippet: string;
  unread: boolean;
  messages: number;
  /** The email task linked to this email, when there is one */
  taskId: number | null;
  gmailUrl: string;
}

export interface InboxView {
  items: InboxItem[];
  /** More inbox emails than are listed */
  more: boolean;
  /** Newsletters and automatic emails left out */
  leftOut: number;
}

export const isThreadId = (id: string) => /^[A-Za-z0-9]{6,40}$/.test(id);

/* ---------- Thread details, kept until Gmail says the thread changed ---------- */

const cache = new Map<string, { historyId: string; metas: MetaMessage[] }>();
let account: string | null = null;

async function myAccount(): Promise<string> {
  account ??= await gmailAccount();
  return account;
}

async function inboxThreads(): Promise<{ list: { id: string; historyId: string }[]; more: boolean }> {
  const list: { id: string; historyId: string }[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 2 && list.length < INBOX_MAX; page++) {
    const p = new URLSearchParams({ q: "in:inbox -in:chats", maxResults: String(INBOX_MAX) });
    if (pageToken) p.set("pageToken", pageToken);
    const body = await proxyJson(CONNECTOR, NAME, "/gmail/v1/users/me/threads?" + p.toString());
    list.push(...((body.threads as { id: string; historyId?: string }[] | undefined) ?? []).map((t) => ({ id: t.id, historyId: String(t.historyId ?? "") })));
    pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined;
    if (!pageToken) break;
  }
  return { list: list.slice(0, INBOX_MAX), more: !!pageToken || list.length > INBOX_MAX };
}

async function metasFor(t: { id: string; historyId: string }): Promise<MetaMessage[] | null> {
  const kept = cache.get(t.id);
  if (kept && t.historyId && kept.historyId === t.historyId) return kept.metas;
  const metas = await threadMeta(t.id);
  if (metas) cache.set(t.id, { historyId: t.historyId, metas });
  return metas;
}

/* ---------- Done: hidden until a new message arrives ---------- */

type DoneMap = Record<string, string>;

async function loadDone(): Promise<DoneMap> {
  const [row] = await db.select().from(appSettingsTable).where(eq(appSettingsTable.key, DONE_KEY));
  return (row?.value as DoneMap | undefined) ?? {};
}

async function saveDone(v: DoneMap) {
  await db
    .insert(appSettingsTable)
    .values({ key: DONE_KEY, value: v })
    .onConflictDoUpdate({ target: appSettingsTable.key, set: { value: v, updatedAt: new Date() } });
}

/* ---------- Tasks linked to inbox emails ---------- */

interface Linked {
  id: number;
  status: string;
  updatedAt: Date;
}

/** Email tasks by thread: the open one when there is one, else the latest. Leaves out tasks from Ollie's own sent email and chases. */
async function linkedTasks(): Promise<Map<string, Linked>> {
  const rows = await db
    .select({ id: tasksTable.id, status: tasksTable.status, updatedAt: tasksTable.updatedAt, sourceUrl: tasksTable.sourceUrl, sourceRef: tasksTable.sourceRef, fromName: tasksTable.fromName, fromAddress: tasksTable.fromAddress })
    .from(tasksTable)
    .where(and(eq(tasksTable.source, "email"), like(tasksTable.sourceUrl, "%#all/%")));
  const out = new Map<string, Linked>();
  for (const r of rows) {
    if (r.sourceRef?.endsWith("#chase")) continue;
    if (!r.fromAddress && r.fromName === "You") continue;
    const threadId = /#all\/([A-Za-z0-9]+)\s*$/.exec(r.sourceUrl ?? "")?.[1];
    if (!threadId) continue;
    const cur = out.get(threadId);
    const open = !CLOSED.has(r.status);
    const curOpen = cur ? !CLOSED.has(cur.status) : false;
    if (!cur || (open && !curOpen) || (open === curOpen && r.updatedAt > cur.updatedAt)) out.set(threadId, { id: r.id, status: r.status, updatedAt: r.updatedAt });
  }
  return out;
}

/** A newsletter, mailing list, automatic email or calendar reply. */
function isBulk(m: MetaMessage): boolean {
  return m.bulk || m.auto || (!!m.from.email && AUTOMATED.test(m.from.email)) || (!!m.subject && INVITE.test(m.subject));
}

function wrapGmail<T>(fn: () => Promise<T>): Promise<T> {
  return fn().catch((err) => {
    if (err instanceof ConnectorError) throw new UpstreamError(`${err.message.replace(/\.$/, "")}. OllieOS needs Gmail to show your inbox.`);
    throw err;
  });
}

interface Waiting {
  threadId: string;
  last: MetaMessage;
  all: MetaMessage[];
}

/** The newest message in a thread, when it is not from Ollie. */
function waitingOn(metas: MetaMessage[], me: string): { last: MetaMessage; all: MetaMessage[] } | null {
  const all = metas.filter((m) => !m.labels.has("DRAFT"));
  const last = all[all.length - 1];
  if (!last || last.labels.has("SENT") || last.from.email === me) return null;
  return { last, all };
}

export async function listInbox(): Promise<InboxView> {
  return wrapGmail(async () => {
    const me = await myAccount();
    const { list, more } = await inboxThreads();
    const metas = await inPool(list, 5, metasFor);
    const [done, linked] = await Promise.all([loadDone(), linkedTasks()]);
    const items: InboxItem[] = [];
    const waiting: Waiting[] = [];
    let leftOut = 0;
    for (const [i, t] of list.entries()) {
      const w = metas[i] ? waitingOn(metas[i]!, me) : null;
      if (!w) continue;
      if (isBulk(w.last)) {
        leftOut++;
        continue;
      }
      waiting.push({ threadId: t.id, ...w });
    }
    for (const { threadId, last, all } of waiting) {
      if (done[threadId] === last.id) continue;
      const task = linked.get(threadId);
      // Closed in OllieOS after the newest message: dealt with.
      if (task && CLOSED.has(task.status) && task.updatedAt.getTime() >= last.at.getTime()) continue;
      items.push({
        threadId,
        messageId: last.id,
        subject: last.subject ?? all.find((m) => m.subject)?.subject ?? null,
        fromName: last.from.name,
        fromEmail: last.from.email,
        at: last.at,
        snippet: decodeEntities(last.snippet),
        unread: all.some((m) => m.labels.has("UNREAD")),
        messages: all.length,
        taskId: task && !CLOSED.has(task.status) ? task.id : null,
        gmailUrl: gmailThreadUrl(me, threadId),
      });
    }
    // Forget Done marks for emails no longer in the inbox.
    const inInbox = new Set(list.map((t) => t.id));
    const kept = Object.fromEntries(Object.entries(done).filter(([id]) => inInbox.has(id)));
    if (Object.keys(kept).length !== Object.keys(done).length) await saveDone(kept);
    items.sort((a, b) => b.at.getTime() - a.at.getTime());
    return { items, more, leftOut };
  });
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function freshWaiting(threadId: string): Promise<{ last: MetaMessage; all: MetaMessage[]; me: string }> {
  if (!isThreadId(threadId)) throw new ValidationError("That is not a Gmail thread");
  return wrapGmail(async () => {
    const me = await myAccount();
    const metas = await threadMeta(threadId);
    if (!metas) throw new NotFoundError("That email is no longer in Gmail");
    const all = metas.filter((m) => !m.labels.has("DRAFT"));
    const last = all[all.length - 1];
    if (!last) throw new NotFoundError("That email is no longer in Gmail");
    return { last, all, me };
  });
}

/**
 * The email task for an inbox email, made when Ollie first acts on it (Brief a reply, Reply, Save
 * to Library). An open task already linked to the email is used instead.
 */
export async function ensureInboxTask(threadId: string, actor: string): Promise<{ taskId: number }> {
  const { last, all, me } = await freshWaiting(threadId);
  const open = (await linkedTasks()).get(threadId);
  if (open && !CLOSED.has(open.status)) return { taskId: open.id };
  const theirs = [...all].reverse().find((m) => !m.labels.has("SENT") && m.from.email !== me) ?? last;
  const subject = theirs.subject ?? all.find((m) => m.subject)?.subject ?? null;
  const who = theirs.from.name ?? theirs.from.email ?? "someone";
  const r = await captureTask(
    { actor, clientId: null },
    {
      title: `Reply to ${who}${subject ? `: ${subject}` : ""}`.slice(0, 200),
      status: "now",
      source: "email",
      sourceRef: `gmail:${theirs.id}`,
      sourceUrl: gmailThreadUrl(me, threadId),
      sourceSubject: subject,
      snippet: decodeEntities(theirs.snippet).slice(0, 280),
      fromName: theirs.from.name,
      fromAddress: theirs.from.email,
      capturedAt: theirs.at,
    },
    { applyNoise: false, via: "email" },
  );
  if (r.taskId == null) throw new NotFoundError("The email could not be added to OllieOS");
  // The same email was a task before and was closed: open it again.
  if (r.outcome === "duplicate") await updateTask(r.taskId, { status: "now" }, actor);
  return { taskId: r.taskId };
}

/** Done on an inbox email: off To answer until a new message arrives, and its open task marked done. */
export async function markInboxDone(threadId: string, actor: string): Promise<{ taskId: number | null; previousStatus: string | null }> {
  const { last } = await freshWaiting(threadId);
  const done = await loadDone();
  done[threadId] = last.id;
  await saveDone(done);
  const task = (await linkedTasks()).get(threadId);
  let taskId: number | null = null;
  let previousStatus: string | null = null;
  if (task && !CLOSED.has(task.status)) {
    await updateTask(task.id, { status: "done" }, actor);
    taskId = task.id;
    previousStatus = task.status;
  }
  await writeAudit(db, { actor, action: "email_done", entityType: "task", entityId: taskId, payload: { threadId, taskId } });
  return { taskId, previousStatus };
}

/** Undo for Done: back on To answer, and its task back where it was. */
export async function undoInboxDone(threadId: string, taskId: number | null, previousStatus: string | null, actor: string): Promise<void> {
  if (!isThreadId(threadId)) throw new ValidationError("That is not a Gmail thread");
  const done = await loadDone();
  delete done[threadId];
  await saveDone(done);
  if (taskId != null && previousStatus) await updateTask(taskId, { status: previousStatus as never }, actor);
}

/** For tests: forget kept thread details. */
export function clearInboxCache() {
  cache.clear();
  account = null;
}
