import { Router, type IRouter } from "express";
import { z } from "zod";
import { handle } from "../lib/handle";
import { allowForBrief, briefView, nextBriefEventId, updateBriefNotes } from "../services/briefs";
import { getDigest, listDigests } from "../services/digest";
import { listMeetings } from "../services/meetings";
import { NotFoundError } from "../services/tasks";

const router: IRouter = Router();

const EventParams = z.object({ eventId: z.coerce.number().int().positive() });
const NotesBody = z.object({ notes: z.string().max(20000).nullable() }).strict();
const DateParams = z.object({ date: z.string().min(1).max(20) });

/* Meetings page (Assist Part B): this week's work meetings and the last two weeks'. */
router.get("/meetings", handle(async (_req, res) => void res.json(await listMeetings())));

/* Meeting briefs (feature 03). Written on open when missing or more than 3 hours old. */
router.get(
  "/briefs/next",
  handle(async (_req, res) => {
    const id = await nextBriefEventId();
    if (id == null) throw new NotFoundError("No work meeting between now and the end of tomorrow needs a brief");
    res.json(await briefView(id));
  }),
);
router.get("/briefs/:eventId", handle(async (req, res) => void res.json(await briefView(EventParams.parse(req.params).eventId))));
router.post("/briefs/:eventId/refresh", handle(async (req, res) => void res.json(await briefView(EventParams.parse(req.params).eventId, { force: true }))));
router.post("/briefs/:eventId/allow", handle(async (req, res) => void res.json(await allowForBrief(EventParams.parse(req.params).eventId))));
router.patch(
  "/briefs/:eventId",
  handle(async (req, res) => {
    res.json({ notes: await updateBriefNotes(EventParams.parse(req.params).eventId, NotesBody.parse(req.body).notes) });
  }),
);

/* Daily digest (feature 08) */
router.get("/digests", handle(async (_req, res) => void res.json(await listDigests())));
router.get("/digests/:date", handle(async (req, res) => void res.json(await getDigest(DateParams.parse(req.params).date))));

export default router;
