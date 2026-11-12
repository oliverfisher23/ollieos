/**
 * The Email page: the thread behind an email task, its summary and attachments, drafts still to
 * go, "Brief a reply", and the "How you write" note. To answer uses the task list; Waiting for a
 * reply uses /review. Ollie only. Nothing here sends email.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { handle } from "../lib/handle";
import { kickKnowledgeReader } from "../services/documents/reader";
import { dismissEmailDraft, listEmailDrafts, readTaskThread, readThreadView, saveEmailAttachment } from "../services/email";
import { ensureInboxTask, isThreadId, listInbox, markInboxDone, markInboxDoneMany, snoozeInbox, undoInboxDone } from "../services/inbox";
import { messageCounts } from "../services/messages";
import { briefReply } from "../services/replyDraft";
import {
  draftSlackReply,
  ensureSlackTask,
  listSlackToAnswer,
  markSlackDone,
  markSlackDoneMany,
  refreshSlackToAnswer,
  removeSlackDraft,
  saveSlackDraft,
  slackConversation,
  snoozeSlack,
  undoSlackDone,
} from "../services/slackToAnswer";
import { getInboxThreadSummary, getThreadSummary } from "../services/threadSummary";
import { getWritingStyle, readWritingStyle, saveWritingStyle, STYLE_NOTE_CHARS } from "../services/writingStyle";

const router: IRouter = Router();
const IdParams = z.object({ id: z.coerce.number().int().positive() });
const ThreadParams = z.object({ threadId: z.string().refine(isThreadId, "That is not a Gmail thread") });
const ACTOR = "ollie";
const Undo = z.object({ taskId: z.number().int().positive().nullable(), previousStatus: z.enum(["inbox", "now", "backlog", "waiting"]).nullable() });
/** Later: a day after today, or null to bring it back */
const LaterBody = z.object({ until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }).strict();

// Messages: how many need a reply, for the menu. Gmail is looked at again when the last look is old.
router.get("/email/counts", handle(async (_req, res) => void res.json(await messageCounts(new Date(), true))));

// Mark all done: several emails and Slack messages at once, with what Undo needs.
router.post(
  "/email/done-many",
  handle(async (req, res) => {
    const b = z.object({ threadIds: z.array(z.string().refine(isThreadId)).max(200), slackIds: z.array(z.number().int().positive()).max(200) }).strict().parse(req.body ?? {});
    res.json({ emails: await markInboxDoneMany(b.threadIds, ACTOR), slack: await markSlackDoneMany(b.slackIds, ACTOR) });
  }),
);
router.post(
  "/email/undo-done-many",
  handle(async (req, res) => {
    const b = z
      .object({
        emails: z.array(Undo.extend({ threadId: z.string().refine(isThreadId) }).strict()).max(200),
        slack: z.array(Undo.extend({ id: z.number().int().positive() }).strict()).max(200),
      })
      .strict()
      .parse(req.body ?? {});
    for (const e of b.emails) await undoInboxDone(e.threadId, e.taskId, e.previousStatus, ACTOR);
    for (const s of b.slack) await undoSlackDone(s.id, s.taskId, s.previousStatus, ACTOR);
    res.status(204).end();
  }),
);

router.get("/email/drafts", handle(async (_req, res) => void res.json(await listEmailDrafts())));

// To answer: the Gmail inbox, emails whose last message is not from Ollie.
router.get("/email/inbox", handle(async (_req, res) => void res.json(await listInbox())));
router.get(
  "/email/threads/:threadId",
  handle(async (req, res) => {
    const { threadId } = ThreadParams.parse(req.params);
    const view = await readThreadView(threadId);
    res.json(view ?? { fromGmail: false, gmailUrl: null, messages: [] });
  }),
);
router.get(
  "/email/threads/:threadId/summary",
  handle(async (req, res) => {
    const { threadId } = ThreadParams.parse(req.params);
    res.json(await getInboxThreadSummary(threadId));
  }),
);
router.post(
  "/email/inbox/:threadId/task",
  handle(async (req, res) => {
    const { threadId } = ThreadParams.parse(req.params);
    res.json(await ensureInboxTask(threadId, ACTOR));
  }),
);
router.post(
  "/email/inbox/:threadId/done",
  handle(async (req, res) => {
    const { threadId } = ThreadParams.parse(req.params);
    res.json(await markInboxDone(threadId, ACTOR));
  }),
);
router.post(
  "/email/inbox/:threadId/undo-done",
  handle(async (req, res) => {
    const { threadId } = ThreadParams.parse(req.params);
    const b = z
      .object({ taskId: z.number().int().positive().nullable(), previousStatus: z.enum(["inbox", "now", "backlog", "waiting"]).nullable() })
      .strict()
      .parse(req.body ?? {});
    await undoInboxDone(threadId, b.taskId, b.previousStatus, ACTOR);
    res.status(204).end();
  }),
);
router.post(
  "/email/inbox/:threadId/later",
  handle(async (req, res) => {
    const { threadId } = ThreadParams.parse(req.params);
    await snoozeInbox(threadId, LaterBody.parse(req.body ?? {}).until, ACTOR);
    res.status(204).end();
  }),
);
// Slack to answer (Part P): conversations whose newest message waits on Ollie. Nothing is posted to Slack.
router.get("/email/slack", handle(async (_req, res) => void res.json(await listSlackToAnswer())));
// Check now: looks at the listed conversations again and closes those Ollie has answered.
router.post("/email/slack/refresh", handle(async (_req, res) => void res.json({ closed: await refreshSlackToAnswer() })));
router.get(
  "/email/slack/:id/messages",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    res.json(await slackConversation(id));
  }),
);
router.post(
  "/email/slack/:id/later",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    await snoozeSlack(id, LaterBody.parse(req.body ?? {}).until, ACTOR);
    res.status(204).end();
  }),
);
router.put(
  "/email/slack/:id/draft",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    const b = z.object({ text: z.string().max(4000) }).strict().parse(req.body ?? {});
    res.json(await saveSlackDraft(id, b.text));
  }),
);
router.delete(
  "/email/slack/:id/draft",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    await removeSlackDraft(id);
    res.status(204).end();
  }),
);
router.post(
  "/email/slack/:id/done",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    res.json(await markSlackDone(id, ACTOR));
  }),
);
router.post(
  "/email/slack/:id/undo-done",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    const b = z
      .object({ taskId: z.number().int().positive().nullable(), previousStatus: z.enum(["inbox", "now", "backlog", "waiting"]).nullable() })
      .strict()
      .parse(req.body ?? {});
    await undoSlackDone(id, b.taskId, b.previousStatus, ACTOR);
    res.status(204).end();
  }),
);
router.post(
  "/email/slack/:id/task",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    res.json(await ensureSlackTask(id, ACTOR));
  }),
);
router.post(
  "/email/slack/:id/draft",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    const b = z.object({ brief: z.string().max(500).nullish(), change: z.string().max(500).nullish() }).strict().parse(req.body ?? {});
    res.json(await draftSlackReply(id, ACTOR, b));
  }),
);
router.get(
  "/tasks/:id/thread",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    res.json(await readTaskThread(id));
  }),
);
router.get(
  "/tasks/:id/thread/summary",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    res.json(await getThreadSummary(id));
  }),
);
router.post(
  "/tasks/:id/thread/attachments",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    const b = z.object({ messageId: z.string().min(1).max(200), partId: z.string().max(50) }).strict().parse(req.body ?? {});
    const doc = await saveEmailAttachment(id, b.messageId, b.partId, ACTOR);
    kickKnowledgeReader();
    res.status(201).json(doc);
  }),
);
router.post(
  "/tasks/:id/reply-draft/brief",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    const b = z.object({ brief: z.string().min(1).max(500) }).strict().parse(req.body ?? {});
    res.status(202).json(await briefReply(id, b.brief, ACTOR));
  }),
);
router.post(
  "/tasks/:id/reply-draft/dismiss",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    res.json(await dismissEmailDraft(id, ACTOR));
  }),
);

// "How you write": the note every draft follows.
router.get("/email/style", handle(async (_req, res) => void res.json(await getWritingStyle())));
router.put(
  "/email/style",
  handle(async (req, res) => {
    const b = z.object({ note: z.string().max(STYLE_NOTE_CHARS) }).strict().parse(req.body ?? {});
    res.json(await saveWritingStyle(b.note, ACTOR));
  }),
);
router.post("/email/style/read", handle(async (_req, res) => void res.status(202).json(await readWritingStyle(ACTOR))));

export default router;
