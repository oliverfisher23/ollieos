/** Review items: actions from a Granola look back (Review page) and unanswered emails (Email page, No reply yet). Ollie only. */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { handle } from "../lib/handle";
import { getNoReplyScan, resumeNoReplyScan, startNoReplyScan, stopNoReplyScan } from "../services/connectors/noReply";
import { decideReview, listReview, REVIEW_ACTIONS, setExpectedBy } from "../services/review";

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

// Waiting for a reply: the day a reply is expected by.
router.put(
  "/review/:id/expected-by",
  handle(async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const b = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict().parse(req.body ?? {});
    res.json(await setExpectedBy(id, b.date));
  }),
);

// No reply yet: the one-off look through sent mail, in the background.
router.get("/review/no-reply", handle(async (_req, res) => void res.json(await getNoReplyScan())));
router.post("/review/no-reply", handle(async (_req, res) => void res.json(await startNoReplyScan())));
router.post("/review/no-reply/stop", handle(async (_req, res) => void res.json(await stopNoReplyScan())));
router.post("/review/no-reply/resume", handle(async (_req, res) => void res.json(await resumeNoReplyScan())));

export default router;
