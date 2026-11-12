import { Router, type IRouter } from "express";
import { z } from "zod";
import { handle } from "../lib/handle";
import { decideSessionQuestion, deleteSession, listSessions, readSessionAgain, sessionDetail, updateSession } from "../services/sessions";

/** Cowork sessions (build plan 13, Part F): Claude saves them; Ollie reads, hides and deletes them. */
const router: IRouter = Router();

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const ListQuery = z.object({ q: z.string().max(300).optional() });
const SessionUpdate = z.object({ confidential: z.boolean().nullable().optional() }).strict();

router.get("/sessions", handle(async (req, res) => void res.json(await listSessions(ListQuery.parse(req.query)))));
router.get("/sessions/:id", handle(async (req, res) => void res.json(await sessionDetail(IdParams.parse(req.params).id))));
router.patch("/sessions/:id", handle(async (req, res) => void res.json(await updateSession(IdParams.parse(req.params).id, SessionUpdate.parse(req.body)))));
const QuestionBody = z.object({ question: z.string().min(1).max(600), action: z.enum(["task", "dismiss"]) }).strict();
router.post(
  "/sessions/:id/questions",
  handle(async (req, res) => {
    const b = QuestionBody.parse(req.body);
    res.json(await decideSessionQuestion(IdParams.parse(req.params).id, b.question, b.action));
  }),
);
router.post("/sessions/:id/knowledge", handle(async (req, res) => void res.json(await readSessionAgain(IdParams.parse(req.params).id))));
router.delete(
  "/sessions/:id",
  handle(async (req, res) => {
    await deleteSession(IdParams.parse(req.params).id);
    res.status(204).end();
  }),
);

export default router;
