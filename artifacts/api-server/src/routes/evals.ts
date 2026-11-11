/**
 * Part X (test cases and replays) and Part Y (thumbs) of build plan section 21.
 */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { handle } from "../lib/handle";
import { keepTestCase, listReplays, listTestCases, removeTestCase, replay, testCaseFor } from "../services/evals";
import { setThumb, thumbsFor } from "../services/writerChecks";

const router: IRouter = Router();
const IdParams = z.object({ id: z.coerce.number().int().positive() });

router.get(
  "/tasks/:id/test-case",
  handle(async (req, res) => void res.json(await testCaseFor(IdParams.parse(req.params).id))),
);

router.post(
  "/tasks/:id/test-case",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    const b = z.object({ expected: z.enum(["task", "no_task"]).optional(), note: z.string().max(500).nullish() }).strict().parse(req.body ?? {});
    res.status(201).json(await keepTestCase(id, b, "ollie"));
  }),
);

router.get(
  "/evals/cases",
  handle(async (req, res) => {
    const { agent } = z.object({ agent: z.string().max(60).optional() }).parse(req.query);
    res.json(await listTestCases(agent));
  }),
);

router.delete(
  "/evals/cases/:id",
  handle(async (req, res) => {
    await removeTestCase(IdParams.parse(req.params).id);
    res.status(204).end();
  }),
);

router.post(
  "/evals/replay",
  handle(async (req, res) => {
    const b = z.object({ agent: z.string().min(1).max(60), model: z.string().max(80).nullish() }).strict().parse(req.body ?? {});
    res.json(await replay(b.agent, { model: b.model }, "ollie"));
  }),
);

router.get("/evals/replays", handle(async (_req, res) => void res.json(await listReplays())));

router.get(
  "/feedback",
  handle(async (req, res) => {
    const { subjects } = z.object({ subjects: z.string().max(2000).default("") }).parse(req.query);
    const list = subjects.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 100);
    const map = await thumbsFor(list);
    res.json(list.map((subject) => ({ subject, thumb: map.get(subject) ?? null })));
  }),
);

router.post(
  "/feedback",
  handle(async (req, res) => {
    const b = z.object({ subject: z.string().min(1).max(40), thumb: z.enum(["up", "down"]).nullable(), note: z.string().max(500).nullish() }).strict().parse(req.body ?? {});
    res.json(await setThumb(b.subject, b.thumb, b.note));
  }),
);

export default router;
