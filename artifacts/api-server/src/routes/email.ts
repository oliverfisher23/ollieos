/**
 * The Email page: the thread behind an email task, its summary and attachments, drafts still to
 * go, "Brief a reply", and the "How you write" note. To answer uses the task list; Waiting for a
 * reply uses /review. Ollie only. Nothing here sends email.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { handle } from "../lib/handle";
import { kickKnowledgeReader } from "../services/documents/reader";
import { dismissEmailDraft, listEmailDrafts, readTaskThread, saveEmailAttachment } from "../services/email";
import { briefReply } from "../services/replyDraft";
import { getThreadSummary } from "../services/threadSummary";
import { getWritingStyle, readWritingStyle, saveWritingStyle, STYLE_NOTE_CHARS } from "../services/writingStyle";

const router: IRouter = Router();
const IdParams = z.object({ id: z.coerce.number().int().positive() });
const ACTOR = "ollie";

router.get("/email/drafts", handle(async (_req, res) => void res.json(await listEmailDrafts())));
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
