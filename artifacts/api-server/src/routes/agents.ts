/** The Agents page (build plan section 21, Part V): every AI agent and connected AI. Ollie only. */
import { Router, type IRouter } from "express";
import { handle } from "../lib/handle";
import { z } from "zod";
import { agentsView } from "../services/agents";
import { learnLessons, listLessons, setLessonStatus, tryLesson } from "../services/readerLessons";

const router: IRouter = Router();

router.get("/agents", handle(async (_req, res) => void res.json(await agentsView())));

// Section 24: lessons for the readers, learned from Ollie's corrections. Nothing applies until he turns it on.
const IdParams = z.object({ id: z.coerce.number().int().positive() });
router.get("/lessons", handle(async (_req, res) => void res.json(await listLessons())));
router.post("/lessons/learn", handle(async (_req, res) => void res.json(await learnLessons())));
router.patch(
  "/lessons/:id",
  handle(async (req, res) => {
    const b = z.object({ status: z.enum(["on", "off", "rejected"]) }).strict().parse(req.body ?? {});
    res.json(await setLessonStatus(IdParams.parse(req.params).id, b.status));
  }),
);
router.post("/lessons/:id/try", handle(async (req, res) => void res.json(await tryLesson(IdParams.parse(req.params).id))));

export default router;
