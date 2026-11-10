/**
 * The Email page's Drafts list (Assist Part D): every reply and chase email OllieOS has drafted
 * that is still to go. A draft leaves the list when a Gmail check sees Ollie send an email in the
 * thread after it was written or last saved, when its task is closed, or when Ollie marks it done
 * (the draft stays on the task). A sent reply also marks its email task done; a sent chase leaves
 * its Waiting on task as it is. OllieOS never sends email.
 */
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, documentContentsTable, documentsTable, replyDraftsTable, tasksTable } from "@workspace/db";
import { OPEN_STATUSES, formatLong } from "@workspace/shared";
import { writeAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { ConnectorError } from "./connectors/http";
import { gmailThreadUrl, inPool, readGmailAttachment, readGmailThread, type Address, type GmailAttachment } from "./connectors/gmail";
import { enqueueDocument } from "./documents/enqueue";
import { isReadableName, textFromFile, titleFromFileName } from "./documents/fileText";
import { documentView, insertDocument, keepDocumentText, type DocumentView } from "./library";
import { threadMeta } from "./connectors/noReply";
import { loadEmailTask, threadIdFor, view, type ReplyDraftView } from "./replyDraft";
import { ConflictError, NotFoundError, UpstreamError, ValidationError, loadTask, updateTask } from "./tasks";

/** Email tasks still waiting on Ollie's answer */
const TO_ANSWER: string[] = ["inbox", "now", "backlog"];

/** How many open drafts each Gmail check looks at for a sent email */
const SENT_CHECK_LIMIT = 40;

export interface EmailDraftItem {
  draft: ReplyDraftView;
  task: {
    id: number;
    title: string;
    status: string;
    fromName: string | null;
    fromAddress: string | null;
    sourceSubject: string | null;
    sourceUrl: string | null;
    confidential: boolean;
  };
  /** A follow-up to an email nobody answered (Chase), rather than a reply */
  chase: boolean;
}

const open = () =>
  and(isNull(replyDraftsTable.sentAt), isNull(replyDraftsTable.dismissedAt), inArray(tasksTable.status, [...OPEN_STATUSES]));

export async function listEmailDrafts(): Promise<{ items: EmailDraftItem[] }> {
  const rows = await db
    .select({ d: replyDraftsTable, t: tasksTable })
    .from(replyDraftsTable)
    .innerJoin(tasksTable, eq(tasksTable.id, replyDraftsTable.taskId))
    .where(open())
    .orderBy(desc(replyDraftsTable.updatedAt))
    .limit(200);
  return {
    items: rows.map(({ d, t }) => ({
      draft: view(d),
      task: {
        id: t.id,
        title: t.title,
        status: t.status,
        fromName: t.fromName,
        fromAddress: t.fromAddress,
        sourceSubject: t.sourceSubject,
        sourceUrl: t.sourceUrl,
        confidential: t.confidential === true,
      },
      chase: !!t.sourceRef?.endsWith("#chase"),
    })),
  };
}

/** Takes a draft off the Drafts list. The draft stays on its task. */
export async function dismissEmailDraft(taskId: number, actor: string): Promise<ReplyDraftView> {
  await loadTask(taskId);
  const [row] = await db.update(replyDraftsTable).set({ dismissedAt: new Date() }).where(eq(replyDraftsTable.taskId, taskId)).returning();
  if (!row) throw new NotFoundError("There is no draft for that task");
  await writeAudit(db, { actor, action: "reply_draft", entityType: "task", entityId: taskId, payload: { dismissed: true } });
  return view(row);
}

/**
 * On each Gmail check: marks open drafts as sent when Ollie has sent an email in their thread
 * since the draft was written or last saved to Gmail. Returns how many it marked.
 */
export async function checkSentDrafts(): Promise<number> {
  const rows = await db
    .select({ id: replyDraftsTable.id, taskId: replyDraftsTable.taskId, threadId: replyDraftsTable.threadId, updatedAt: replyDraftsTable.updatedAt, status: tasksTable.status, sourceRef: tasksTable.sourceRef })
    .from(replyDraftsTable)
    .innerJoin(tasksTable, eq(tasksTable.id, replyDraftsTable.taskId))
    .where(and(open(), isNotNull(replyDraftsTable.threadId)))
    .orderBy(desc(replyDraftsTable.updatedAt))
    .limit(SENT_CHECK_LIMIT);
  if (!rows.length) return 0;
  const metas = await inPool(rows, 5, async (r) => {
    try {
      return await threadMeta(r.threadId!);
    } catch (err) {
      logger.warn({ err }, "Could not check a draft's thread for a sent email");
      return null;
    }
  });
  let marked = 0;
  for (const [i, r] of rows.entries()) {
    const sent = (metas[i] ?? []).filter((m) => m.labels.has("SENT") && !m.labels.has("DRAFT") && m.at.getTime() > r.updatedAt.getTime());
    if (!sent.length) continue;
    // Set without touching updatedAt, so the time it was last written or saved stays as it was.
    await db.update(replyDraftsTable).set({ sentAt: sent[sent.length - 1].at, updatedAt: r.updatedAt }).where(eq(replyDraftsTable.id, r.id));
    marked++;
    // The reply went, so the email is answered. A chase stays Waiting on until they answer.
    if (!r.sourceRef?.endsWith("#chase") && TO_ANSWER.includes(r.status)) {
      try {
        await updateTask(r.taskId, { status: "done" }, "ollieos");
      } catch (err) {
        logger.warn({ err, task: r.taskId }, "Could not mark an answered email done");
      }
    }
  }
  return marked;
}

/** How much of each message the reading view shows */
const READ_CHARS = 20_000;

export interface EmailThreadMessage {
  id: string;
  fromName: string | null;
  fromEmail: string | null;
  to: string;
  cc: string;
  at: Date;
  text: string;
  fromOllie: boolean;
  attachments: EmailAttachmentView[];
}

export interface EmailAttachmentView {
  partId: string;
  filename: string;
  size: number;
  /** A PDF, Word or text file under 10 MB, which can be saved to the Library */
  canSave: boolean;
  /** The Library document it was saved as */
  documentId: number | null;
}

/** Largest attachment that can be saved to the Library */
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** The Library keeps where an attachment came from as gmail:<thread>/<message>/<part>. */
const attachmentKey = (threadId: string, messageId: string, partId: string) => `gmail:${threadId}/${messageId}/${partId}`;

const canSave = (a: Pick<GmailAttachment, "filename" | "size">) => isReadableName(a.filename) && a.size > 0 && a.size <= ATTACHMENT_MAX_BYTES;

export interface EmailThreadView {
  /** False when the email is not in Gmail (gone, or it came in another way): messages then hold what the task kept */
  fromGmail: boolean;
  gmailUrl: string | null;
  messages: EmailThreadMessage[];
}

const line = (list: Address[]) => list.map((a) => (a.name && a.email ? `${a.name} <${a.email}>` : (a.email ?? a.name ?? ""))).filter(Boolean).join(", ");

/** The email thread behind an email task, oldest first, for the Email page's reading view. Read only. */
export async function readTaskThread(id: number): Promise<EmailThreadView> {
  const task = await loadTask(id);
  loadEmailTask(task);
  try {
    const threadId = await threadIdFor(task);
    const thread = threadId ? await readGmailThread(threadId, READ_CHARS) : null;
    if (thread && thread.messages.length) {
      const keys = thread.messages.flatMap((m) => m.attachments.map((a) => attachmentKey(thread.threadId, m.id, a.partId)));
      const saved = keys.length
        ? await db
            .select({ key: documentContentsTable.fileId, id: documentContentsTable.documentId })
            .from(documentContentsTable)
            .where(and(eq(documentContentsTable.origin, "email"), inArray(documentContentsTable.fileId, keys)))
        : [];
      const savedAs = new Map(saved.map((r) => [r.key, r.id]));
      return {
        fromGmail: true,
        gmailUrl: gmailThreadUrl(thread.account, thread.threadId),
        messages: thread.messages.map((m) => ({
          id: m.id,
          fromName: m.from.name,
          fromEmail: m.from.email,
          to: line(m.to),
          cc: line(m.cc),
          at: m.at,
          text: m.text,
          fromOllie: !!m.from.email && m.from.email === thread.account,
          attachments: m.attachments.map((a) => ({
            partId: a.partId,
            filename: a.filename,
            size: a.size,
            canSave: canSave(a),
            documentId: savedAs.get(attachmentKey(thread.threadId, m.id, a.partId)) ?? null,
          })),
        })),
      };
    }
  } catch (err) {
    if (err instanceof ConnectorError) throw new UpstreamError(`${err.message.replace(/\.$/, "")}. OllieOS needs Gmail to show the email.`);
    throw err;
  }
  const text = [task.sourceQuote, task.snippet].filter(Boolean).join("\n\n");
  return {
    fromGmail: false,
    gmailUrl: task.sourceUrl,
    messages: text
      ? [{ id: "task", fromName: task.fromName, fromEmail: task.fromAddress, to: "", cc: "", at: task.capturedAt ?? task.createdAt, text, fromOllie: false, attachments: [] }]
      : [],
  };
}

/**
 * "Save to Library" on an email attachment: keeps the file's text in the Library, linked to the
 * task's project and confidential when the task is, and queues it to be read for knowledge. The
 * knowledge it finds cites the email.
 */
export async function saveEmailAttachment(taskId: number, messageId: string, partId: string, actor: string): Promise<DocumentView> {
  const task = await loadTask(taskId);
  loadEmailTask(task);
  let file: Awaited<ReturnType<typeof readGmailAttachment>>;
  let threadId: string | null;
  try {
    threadId = await threadIdFor(task);
    file = threadId ? await readGmailAttachment(messageId, partId) : null;
  } catch (err) {
    if (err instanceof ConnectorError) throw new UpstreamError(`${err.message.replace(/\.$/, "")}. OllieOS needs Gmail to read the attachment.`);
    throw err;
  }
  if (!file || !threadId) throw new NotFoundError("That attachment is no longer in Gmail");
  if (file.threadId !== threadId) throw new NotFoundError("That attachment is not part of this email");
  if (!isReadableName(file.filename)) throw new ValidationError("OllieOS can save PDF, Word (.docx) and text files to the Library.");
  if (file.bytes.byteLength > ATTACHMENT_MAX_BYTES) throw new ValidationError("That file is over 10 MB, so it cannot be saved to the Library.");

  const key = attachmentKey(threadId, messageId, partId);
  const [already] = await db
    .select({ id: documentContentsTable.documentId, title: documentsTable.title })
    .from(documentContentsTable)
    .innerJoin(documentsTable, eq(documentsTable.id, documentContentsTable.documentId))
    .where(and(eq(documentContentsTable.origin, "email"), eq(documentContentsTable.fileId, key)));
  if (already) throw new ConflictError(`That attachment is already in the Library as "${already.title}"`);

  const text = (await textFromFile(file.filename, new Uint8Array(file.bytes))).trim();
  if (!text) throw new ValidationError(`There is no text to read in ${file.filename}.`);
  const sender = task.fromName ?? task.fromAddress ?? "someone";
  const subject = task.sourceSubject ?? task.title;
  const id = await db.transaction(async (tx) => {
    const id = await insertDocument(
      tx,
      {
        title: titleFromFileName(file!.filename),
        summary: `Attached to the email "${subject}" from ${sender}, ${formatLong(task.capturedAt ?? task.createdAt, { withYear: true })}.`,
        confidential: task.confidential === true ? true : null,
        projectIds: task.projectId ? [task.projectId] : [],
      },
      actor,
    );
    await keepDocumentText(tx, id, text, "email", { fileId: key, originName: file!.filename });
    const [d] = await tx.select({ title: documentsTable.title }).from(documentsTable).where(eq(documentsTable.id, id));
    await enqueueDocument(tx, { id, title: d.title, url: null });
    return id;
  });
  return documentView(id);
}
