/** The Review page: actions from a Granola look back and unanswered emails, waiting for Ollie. Ollie only. */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { handle } from "../lib/handle";
import { getNoReplyScan, resumeNoReplyScan, startNoReplyScan, stopNoReplyScan } from "../services/connectors/noReply";
import { decideReview, listReview, REVIEW_ACTIONS } from "../services/review";

const router: IRouter = Router();

const DecideBody = z
  .object({
    ids: z.array(z.number().int().positive()).min(1).max(500),
    action: z.enum(REVIEW_ACTIONS),
    waitingOnPersonId: z.number().int().positive().nullable().optional(),
  })
  .strict();

router.get("/review", handle(async (_req, res) => void res.json(await listReview())));
router.post(
  "/review/decide",
  handle(async (req, res) => {
    const b = DecideBody.parse(req.body ?? {});
    res.json({ items: await decideReview(b.ids, { action: b.action, waitingOnPersonId: b.waitingOnPersonId }) });
  }),
);

// No reply yet: the one-off look through sent mail, in the background.
router.get("/review/no-reply", handle(async (_req, res) => void res.json(await getNoReplyScan())));
router.post("/review/no-reply", handle(async (_req, res) => void res.json(await startNoReplyScan())));
router.post("/review/no-reply/stop", handle(async (_req, res) => void res.json(await stopNoReplyScan())));
router.post("/review/no-reply/resume", handle(async (_req, res) => void res.json(await resumeNoReplyScan())));

export default router;
