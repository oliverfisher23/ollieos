/**
 * The Email page's Drafts list (Assist Part D): every reply and chase email OllieOS has drafted
 * that is still to go. A draft leaves the list when a Gmail check sees Ollie send an email in the
 * thread after it was written or last saved, when its task is closed, or when Ollie marks it done
 * (the draft stays on the task). OllieOS never sends email.
 */
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db, replyDraftsTable, tasksTable } from "@workspace/db";
import { OPEN_STATUSES } from "@workspace/shared";
import { writeAudit } from "../lib/audit";
import { logger } from "../lib/logger";
import { inPool } from "./connectors/gmail";
import { threadMeta } from "./connectors/noReply";
import { view, type ReplyDraftView } from "./replyDraft";
import { NotFoundError, loadTask } from "./tasks";

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
    .select({ id: replyDraftsTable.id, threadId: replyDraftsTable.threadId, updatedAt: replyDraftsTable.updatedAt })
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
  }
  return marked;
}
