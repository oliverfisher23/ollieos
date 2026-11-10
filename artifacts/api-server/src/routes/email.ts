/** The Email page: the thread behind an email task, and drafts still to go. To answer uses the task list; No reply yet uses /review/no-reply. Ollie only. */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { handle } from "../lib/handle";
import { dismissEmailDraft, listEmailDrafts, readTaskThread } from "../services/email";

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
router.post(
  "/tasks/:id/reply-draft/dismiss",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    res.json(await dismissEmailDraft(id, ACTOR));
  }),
);

export default router;
