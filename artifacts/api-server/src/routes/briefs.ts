import { Router, type IRouter } from "express";
import { keepSeries, timeReport, weekCheck, worthALook } from "../services/timeAndMeetings";
import { z } from "zod";
import { handle } from "../lib/handle";
import { allowForBrief, briefView, markBriefOpened, nextBriefEventId } from "../services/briefs";
import { addPoint, POINT_CHARS } from "../services/talkingPoints";
import { getDigest, listDigests } from "../services/digest";
import { listMeetings, meetingView, updateMeetingNotes } from "../services/meetings";
import { MAX_THOUGHTS, clearAgendaChat, shapeAgenda } from "../services/meetingAgenda";
import { linkGranolaNote } from "../services/connectors";
import { setThreadVerdict } from "../services/threadMatch";
import { NotFoundError } from "../services/tasks";

const router: IRouter = Router();

const EventParams = z.object({ eventId: z.coerce.number().int().positive() });
const NotesBody = z.object({ notes: z.string().max(20000).nullable() }).strict();
const DateParams = z.object({ date: z.string().min(1).max(20) });

/* Meetings page (Assist Part B): this week's work meetings and the last two weeks'. */
router.get("/meetings", handle(async (_req, res) => void res.json(await listMeetings())));
// Part R: where time went, whether the week fits, and repeating meetings worth a look.
router.get("/time", handle(async (_req, res) => void res.json(await timeReport())));
router.get("/week-check", handle(async (_req, res) => void res.json(await weekCheck())));
router.get("/meetings/worth-a-look", handle(async (_req, res) => void res.json(await worthALook())));
router.post(
  "/meetings/worth-a-look/:seriesId/keep",
  handle(async (req, res) => {
    const { seriesId } = z.object({ seriesId: z.string().min(1).max(300) }).parse(req.params);
    await keepSeries(seriesId);
    res.status(204).end();
  }),
);

// Any work meeting, with or without a prep page: who is coming and Ollie's agenda and notes.
router.get("/meetings/:eventId", handle(async (req, res) => void res.json(await meetingView(EventParams.parse(req.params).eventId))));
router.patch(
  "/meetings/:eventId",
  handle(async (req, res) => {
    res.json({ notes: await updateMeetingNotes(EventParams.parse(req.params).eventId, NotesBody.parse(req.body).notes) });
  }),
);

// Ollie's thoughts into an agenda he can edit; the agenda he sends is the starting point.
router.post(
  "/meetings/:eventId/agenda",
  handle(async (req, res) => {
    const { eventId } = EventParams.parse(req.params);
    const b = z.object({ message: z.string().min(1).max(MAX_THOUGHTS), agenda: z.string().max(20000) }).strict().parse(req.body ?? {});
    res.json(await shapeAgenda(eventId, b));
  }),
);
router.delete(
  "/meetings/:eventId/agenda/chat",
  handle(async (req, res) => {
    await clearAgendaChat(EventParams.parse(req.params).eventId);
    res.status(204).end();
  }),
);

// Link a Granola note OllieOS did not match, from its link.
router.post(
  "/meetings/:eventId/granola",
  handle(async (req, res) => {
    const { eventId } = EventParams.parse(req.params);
    const b = z.object({ link: z.string().min(1).max(2000) }).strict().parse(req.body ?? {});
    await linkGranolaNote(eventId, b.link);
    res.json(await meetingView(eventId));
  }),
);
// "Not about this meeting" / "It is about this meeting" on Recent email and Slack; the thread matcher learns from it.
router.put(
  "/meetings/:eventId/threads/:activityId",
  handle(async (req, res) => {
    const { eventId, activityId } = z.object({ eventId: z.coerce.number().int().positive(), activityId: z.coerce.number().int().positive() }).parse(req.params);
    const b = z.object({ related: z.boolean() }).strict().parse(req.body ?? {});
    await setThreadVerdict(eventId, activityId, b.related);
    res.status(204).end();
  }),
);

/* Meeting briefs (feature 03). Written on open when missing or more than 3 hours old. */
router.get(
  "/briefs/next",
  handle(async (_req, res) => {
    const id = await nextBriefEventId();
    if (id == null) throw new NotFoundError("No work meeting between now and the end of tomorrow needs a brief");
    res.json(await briefView(id));
  }),
);
router.get(
  "/briefs/:eventId",
  handle(async (req, res) => {
    const { eventId } = EventParams.parse(req.params);
    const view = await briefView(eventId);
    // Part K: opening the prep page clears "Not prepped".
    await markBriefOpened(eventId);
    res.json({ ...view, openedAt: view.openedAt ?? new Date() });
  }),
);
// Part K: add a "Next time I see…" point for someone in the meeting.
router.post(
  "/briefs/:eventId/points",
  handle(async (req, res) => {
    EventParams.parse(req.params);
    const b = z.object({ personId: z.number().int().positive(), text: z.string().min(1).max(POINT_CHARS) }).strict().parse(req.body ?? {});
    res.status(201).json(await addPoint(b.personId, b.text, "ollie"));
  }),
);
router.post("/briefs/:eventId/refresh", handle(async (req, res) => void res.json(await briefView(EventParams.parse(req.params).eventId, { force: true }))));
router.post("/briefs/:eventId/allow", handle(async (req, res) => void res.json(await allowForBrief(EventParams.parse(req.params).eventId))));
router.patch(
  "/briefs/:eventId",
  handle(async (req, res) => {
    res.json({ notes: await updateMeetingNotes(EventParams.parse(req.params).eventId, NotesBody.parse(req.body).notes) });
  }),
);

/* Daily digest (feature 08) */
router.get("/digests", handle(async (_req, res) => void res.json(await listDigests())));
router.get("/digests/:date", handle(async (req, res) => void res.json(await getDigest(DateParams.parse(req.params).date))));

export default router;
