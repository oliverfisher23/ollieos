/**
 * "Draft reply" on email tasks (Assist, Part A). Reads the Gmail thread, plus what AI may see in
 * OllieOS about the people, organisation and work involved and Ollie's rules, through the same
 * filter as Ask OllieOS. Ollie edits the reply, then saves it as a draft in the Gmail thread.
 * OllieOS never sends email.
 */
import { recordEdit } from "./draftLearning";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import { db, peopleTable, replyDraftsTable, tasksTable, type ReplyDraft as ReplyDraftRow, type Task as TaskRow } from "@workspace/db";
import { hasAnyEmail } from "./personMatch";
import { OPEN_STATUSES, formatDayMonth, formatTime, toRef } from "@workspace/shared";
import { applicableRuleRefs, loadVisibleDocs } from "../lib/ai-data/retrieve";
import { recordReads, visibleRefs } from "../lib/ai-data/scope";
import { writeAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { askScope } from "./ask/ask";
import { draftEmailReplyFromDocs, type ReplyThreadMessage } from "./ask/model";
import { ConnectorError } from "./connectors/http";
import { gmailThreadIdOf, gmailThreadUrl, readGmailThread, saveGmailDraft, type Address, type GmailThread, type ThreadMessage } from "./connectors/gmail";
import { ConflictError, NotFoundError, UpstreamError, ValidationError, loadTask } from "./tasks";
import { writingStyleNote } from "./writingStyle";

export interface ReplyDraftView {
  taskId: number;
  to: string;
  cc: string;
  subject: string;
  body: string;
  canSaveToGmail: boolean;
  savedAt: Date | null;
  gmailUrl: string | null;
  /** When a Gmail check saw an email sent in the thread after this draft */
  sentAt: Date | null;
  /** Ollie's one-line brief, when the draft came from "Brief a reply" */
  brief: string | null;
  /** Writing in the background, ready to look at, or the background write failed */
  state: "writing" | "ready" | "failed";
  /** Why it could not be written */
  error: string | null;
  updatedAt: Date;
}

/** The most recent messages the model reads, and how much of each. */
const THREAD_MESSAGES = 8;
const MESSAGE_CHARS = 2500;

/** A background write that has not finished in this long stopped (OllieOS restarted, say). */
export const WRITING_STALE_MS = 10 * 60_000;

export function view(r: ReplyDraftRow, now = new Date()): ReplyDraftView {
  const stale = r.state === "writing" && now.getTime() - r.updatedAt.getTime() > WRITING_STALE_MS;
  return {
    taskId: r.taskId,
    to: r.toLine,
    cc: r.ccLine,
    subject: r.subject,
    body: r.body,
    canSaveToGmail: !!r.threadId,
    savedAt: r.savedAt,
    gmailUrl: r.threadId && r.gmailDraftId ? gmailThreadUrl(r.account, r.threadId) : null,
    sentAt: r.sentAt,
    brief: r.brief,
    state: stale ? "failed" : r.state,
    error: stale ? "Writing the draft stopped part way. Try again." : r.error,
    updatedAt: r.updatedAt,
  };
}

async function assertVisibleToAi(task: TaskRow): Promise<void> {
  const taskRef = toRef("task", task.id);
  if (!(await visibleRefs(await askScope(), [taskRef])).has(taskRef)) {
    throw new ConflictError("This email is hidden from AI, so OllieOS cannot draft a reply. Write it yourself, or allow AI on the task.");
  }
}

export function loadEmailTask(t: TaskRow): void {
  if (t.source !== "email") throw new ConflictError("Draft reply is only for tasks that came from an email");
}

export async function getReplyDraft(id: number): Promise<ReplyDraftView | null> {
  await loadTask(id);
  const [row] = await db.select().from(replyDraftsTable).where(eq(replyDraftsTable.taskId, id));
  return row ? view(row) : null;
}

/** The Gmail thread an email task came from, when OllieOS can tell. */
export async function threadIdFor(t: TaskRow): Promise<string | null> {
  const fromUrl = t.sourceUrl ? /mail\.google\.com\/.*#[a-z]+\/([A-Za-z0-9]{10,})\s*$/i.exec(t.sourceUrl)?.[1] : undefined;
  if (fromUrl) return fromUrl;
  const msgId = t.sourceRef?.startsWith("gmail:") ? t.sourceRef.slice("gmail:".length).split("#")[0] : null;
  return msgId ? gmailThreadIdOf(msgId) : null;
}

function addressLine(list: Address[]): string {
  return list
    .filter((a) => a.email)
    .map((a) => (a.name ? `${/[,;"]/.test(a.name) ? `"${a.name.replace(/"/g, "")}"` : a.name} <${a.email}>` : a.email!))
    .join(", ");
}

function uniq(list: Address[], skip: Set<string>): Address[] {
  const seen = new Set(skip);
  return list.filter((a) => a.email && !seen.has(a.email) && (seen.add(a.email), true));
}

interface Envelope {
  to: Address[];
  cc: Address[];
  subject: string;
  inReplyTo: string | null;
  references: string | null;
  /** The message being answered */
  target: ThreadMessage | null;
}

/** Reply-all to the latest message from someone else, or the latest message's recipients when Ollie wrote last. */
export function replyEnvelope(thread: GmailThread, fallbackSubject: string | null): Envelope {
  const me = thread.account;
  const msgs = thread.messages;
  const last = msgs[msgs.length - 1] ?? null;
  const target = [...msgs].reverse().find((m) => m.from.email !== me) ?? null;
  let to: Address[];
  let cc: Address[];
  if (target && target === last) {
    to = uniq(target.replyTo.length ? target.replyTo : [target.from], new Set([me]));
    cc = uniq([...target.to, ...target.cc], new Set([me, ...to.map((a) => a.email!)]));
  } else {
    to = uniq(last?.to ?? [], new Set([me]));
    cc = uniq(last?.cc ?? [], new Set([me, ...to.map((a) => a.email!)]));
  }
  const base = msgs.find((m) => m.subject)?.subject ?? fallbackSubject ?? "";
  return {
    to,
    cc,
    subject: !base ? "" : /^re:/i.test(base) ? base : `Re: ${base}`,
    inReplyTo: last?.messageId ?? null,
    references: last?.references ?? null,
    target,
  };
}

/** Refs for the people, organisation and work the email is about. */
async function contextRefs(t: TaskRow, senderEmails: string[]): Promise<string[]> {
  const refs = [toRef("task", t.id)];
  let personId = t.personId ?? t.waitingOnPersonId;
  if (!personId && senderEmails.length) {
    const [p] = await db
      .select({ id: peopleTable.id })
      .from(peopleTable)
      .where(and(hasAnyEmail(senderEmails), eq(peopleTable.isSelf, false)))
      .limit(1);
    personId = p?.id ?? null;
  }
  if (t.projectId) refs.push(toRef("project", t.projectId));
  if (personId) {
    refs.push(toRef("person", personId));
    const [p] = await db.select({ organisationId: peopleTable.organisationId }).from(peopleTable).where(eq(peopleTable.id, personId));
    if (p?.organisationId) refs.push(toRef("organisation", p.organisationId));
    const others = await db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(
        and(
          inArray(tasksTable.status, [...OPEN_STATUSES]),
          ne(tasksTable.id, t.id),
          or(eq(tasksTable.personId, personId), eq(tasksTable.waitingOnPersonId, personId)),
        ),
      )
      .orderBy(desc(tasksTable.updatedAt))
      .limit(8);
    refs.push(...others.map((o) => toRef("task", o.id)));
  }
  return refs;
}

function when(d: Date): string {
  return `${formatDayMonth(d)}, ${formatTime(d)}`;
}

export async function writeReplyDraft(
  id: number,
  actor: string,
  input: { instructions?: string; current?: string; brief?: string } = {},
): Promise<ReplyDraftView> {
  const task = await loadTask(id);
  loadEmailTask(task);

  const scope = await askScope();
  await assertVisibleToAi(task);

  let thread: GmailThread | null = null;
  try {
    const threadId = await threadIdFor(task);
    thread = threadId ? await readGmailThread(threadId, MESSAGE_CHARS) : null;
  } catch (err) {
    if (err instanceof ConnectorError) throw new UpstreamError(`${err.message.replace(/\.$/, "")}. OllieOS needs Gmail to read the thread.`);
    throw err;
  }
  if (thread && !thread.messages.length) thread = null;

  // Without the thread (it was deleted, or the email came in another way), the reply is drafted from the task alone.
  const env: Envelope = thread
    ? replyEnvelope(thread, task.sourceSubject)
    : {
        to: task.fromAddress ? [{ name: task.fromName, email: task.fromAddress.toLowerCase() }] : [],
        cc: [],
        subject: task.sourceSubject ? (/^re:/i.test(task.sourceSubject) ? task.sourceSubject : `Re: ${task.sourceSubject}`) : "",
        inReplyTo: null,
        references: null,
        target: null,
      };
  const messages: ReplyThreadMessage[] = thread
    ? thread.messages.slice(-THREAD_MESSAGES).map((m) => ({
        from: [m.from.name, m.from.email].filter(Boolean).join(" "),
        when: when(m.at),
        fromOllie: m.from.email === thread!.account,
        text: m.text,
      }))
    : [
        {
          from: [task.fromName, task.fromAddress].filter(Boolean).join(" ") || "the sender",
          when: when(task.capturedAt ?? task.createdAt),
          fromOllie: false,
          text: [task.sourceQuote, task.snippet].filter(Boolean).join("\n\n") || task.title,
        },
      ];

  const senderEmails = [...new Set([env.target?.from.email, task.fromAddress?.toLowerCase()].filter((e): e is string => !!e))];
  const refs = await contextRefs(task, senderEmails);
  const items = await loadVisibleDocs(scope, refs);
  const rules = await loadVisibleDocs(scope, await applicableRuleRefs(scope, refs));
  const docs = [...rules, ...items];
  await recordReads(scope, docs.map((d) => d.ref), { via: "reply_draft", task: task.id });
  const style = await writingStyleNote();

  const greet = env.to[0]?.name ?? env.target?.from.name ?? task.fromName ?? null;
  let body: string;
  try {
    // Ollie wrote last and nobody answered (No reply yet): the draft is a follow-up, not a reply.
    const chase = messages.length > 0 && messages[messages.length - 1].fromOllie;
    body = await draftEmailReplyFromDocs({ to: greet, task: task.title, thread: messages, docs, chase, instructions: input.instructions, current: input.current?.trim() || undefined, style });
  } catch (err) {
    logger.error({ err }, "Reply draft failed");
    throw new UpstreamError("The reply could not be written just now. Try again in a moment.");
  }
  if (!body) throw new UpstreamError("The reply came back empty. Try again in a moment.");

  const values = {
    toLine: addressLine(env.to),
    ccLine: addressLine(env.cc),
    subject: env.subject,
    body,
    // Part L: kept to compare with what Ollie saves or sends.
    writtenBody: body,
    threadId: thread?.threadId ?? null,
    inReplyTo: env.inReplyTo,
    references: env.references,
    account: thread?.account ?? null,
    savedAt: null,
    // A new draft is back on the Email page's Drafts list.
    sentAt: null,
    dismissedAt: null,
    state: "ready" as const,
    error: null,
    ...(input.brief !== undefined ? { brief: input.brief } : {}),
  };
  // A rewrite keeps the Gmail draft id, so the next save replaces the same draft.
  const [row] = await db
    .insert(replyDraftsTable)
    .values({ taskId: task.id, ...values })
    .onConflictDoUpdate({ target: replyDraftsTable.taskId, set: values })
    .returning();
  await writeAudit(db, { actor, action: "reply_draft", entityType: "task", entityId: task.id, payload: { saved: false, thread: !!thread, instructions: !!input.instructions?.trim(), revised: !!input.current?.trim() } });
  return view(row);
}

export async function saveReplyDraftToGmail(
  id: number,
  input: { to: string; cc: string; subject: string; body: string },
  actor: string,
): Promise<ReplyDraftView> {
  const task = await loadTask(id);
  loadEmailTask(task);
  const [row] = await db.select().from(replyDraftsTable).where(eq(replyDraftsTable.taskId, id));
  if (!row) throw new NotFoundError("Draft a reply first");
  if (!row.threadId) throw new ConflictError("OllieOS cannot find this email in Gmail, so the reply cannot be saved there. Copy it instead.");

  let draftId: string;
  try {
    draftId = await saveGmailDraft(row.threadId, row.gmailDraftId, { ...input, inReplyTo: row.inReplyTo, references: row.references });
  } catch (err) {
    if (err instanceof ConnectorError) throw new UpstreamError(err.message);
    throw err;
  }
  const [saved] = await db
    .update(replyDraftsTable)
    .set({ toLine: input.to.trim(), ccLine: input.cc.trim(), subject: input.subject.trim(), body: input.body, gmailDraftId: draftId, savedAt: new Date() })
    .where(eq(replyDraftsTable.id, row.id))
    .returning();
  await writeAudit(db, { actor, action: "reply_draft", entityType: "task", entityId: id, payload: { saved: true } });
  // Part L: what Ollie changed before saving, to learn rules from.
  await recordEdit(id, "edited", row.writtenBody, input.body).catch((err) => logger.warn({ err, task: id }, "Could not record a draft edit"));
  return view(saved);
}

/* ---------- Brief a reply: written in the background ---------- */

const BRIEF_CHARS = 500;
/** How many drafts are written at once */
const WRITERS = 2;
const waiting: { id: number; actor: string }[] = [];
let writers = 0;
const finished = new Set<() => void>();

/** Resolves once no draft is being written in the background. For tests. */
export function waitForBriefedDrafts(): Promise<void> {
  if (!writers && !waiting.length) return Promise.resolve();
  return new Promise((resolve) => finished.add(resolve));
}

/**
 * "Brief a reply": keeps Ollie's one line, puts the email on Drafts as Writing, and writes the
 * draft in the background. Once written it is saved to the Gmail thread as a draft, never sent.
 */
export async function briefReply(id: number, brief: string, actor: string): Promise<ReplyDraftView> {
  const line = brief.trim().replace(/\s+/g, " ");
  if (!line) throw new ValidationError("Say in a line what the reply should say");
  if (line.length > BRIEF_CHARS) throw new ValidationError(`Keep the brief under ${BRIEF_CHARS} characters`);
  const task = await loadTask(id);
  loadEmailTask(task);
  await assertVisibleToAi(task);
  const [existing] = await db.select({ state: replyDraftsTable.state, updatedAt: replyDraftsTable.updatedAt }).from(replyDraftsTable).where(eq(replyDraftsTable.taskId, id));
  if (existing?.state === "writing" && Date.now() - existing.updatedAt.getTime() <= WRITING_STALE_MS) {
    throw new ConflictError("OllieOS is already writing this draft");
  }
  const values = { brief: line, state: "writing" as const, error: null, sentAt: null, dismissedAt: null };
  const [row] = await db
    .insert(replyDraftsTable)
    .values({ taskId: id, body: "", ...values })
    .onConflictDoUpdate({ target: replyDraftsTable.taskId, set: values })
    .returning();
  await writeAudit(db, { actor, action: "reply_draft", entityType: "task", entityId: id, payload: { briefed: true } });
  waiting.push({ id, actor });
  pump();
  return view(row);
}

function pump() {
  while (writers < WRITERS && waiting.length) {
    const job = waiting.shift()!;
    writers++;
    void writeBriefed(job.id, job.actor).finally(() => {
      writers--;
      pump();
      if (!writers && !waiting.length) {
        for (const f of finished) f();
        finished.clear();
      }
    });
  }
}

async function writeBriefed(id: number, actor: string): Promise<void> {
  try {
    const [row] = await db.select().from(replyDraftsTable).where(eq(replyDraftsTable.taskId, id));
    if (!row || row.state !== "writing") return;
    const d = await writeReplyDraft(id, actor, { instructions: row.brief ?? undefined, brief: row.brief ?? undefined });
    if (d.canSaveToGmail) {
      try {
        await saveReplyDraftToGmail(id, { to: d.to, cc: d.cc, subject: d.subject, body: d.body }, actor);
      } catch (err) {
        // The draft is still on Drafts, ready to look at; Save to Gmail can be tried by hand.
        logger.warn({ err, task: id }, "A briefed draft could not be saved to Gmail");
      }
    }
  } catch (err) {
    const message =
      err instanceof UpstreamError || err instanceof ConflictError || err instanceof NotFoundError || err instanceof ValidationError
        ? err.message
        : "The draft could not be written just now. Try again in a moment.";
    if (!(err instanceof UpstreamError || err instanceof ConflictError)) logger.error({ err, task: id }, "Briefed draft failed");
    await db.update(replyDraftsTable).set({ state: "failed", error: message }).where(eq(replyDraftsTable.taskId, id));
  }
}
