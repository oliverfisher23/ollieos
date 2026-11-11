/** Part O: context packs for Claude, and the weekly round-up with its settings. Ollie only. */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { handle } from "../lib/handle";
import { buildContextPack } from "../services/contextPack";
import { getRoundup, getRoundupSchedule, listRoundups, makeRoundupNow, saveRoundupDraft, setRoundupSchedule } from "../services/roundup";

const router: IRouter = Router();

const PackParams = z.object({ type: z.enum(["project", "product", "organisation"]), id: z.coerce.number().int().positive() });
const IdParams = z.object({ id: z.coerce.number().int().positive() });
const RoundupQuery = z.object({ id: z.coerce.number().int().positive().optional() });
const ScheduleBody = z.object({ day: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23) }).strict();

router.get(
  "/context-packs/:type/:id",
  handle(async (req, res) => {
    const p = PackParams.parse(req.params);
    res.json(await buildContextPack(p.type, p.id));
  }),
);

router.get(
  "/roundups",
  handle(async (req, res) => {
    const q = RoundupQuery.parse(req.query);
    const [roundup, weeks, schedule] = await Promise.all([getRoundup(q.id), listRoundups(), getRoundupSchedule()]);
    res.json({ roundup, weeks, schedule });
  }),
);
router.post("/roundups", handle(async (_req, res) => void res.json(await makeRoundupNow())));
router.post("/roundups/:id/draft", handle(async (req, res) => void res.json(await saveRoundupDraft(IdParams.parse(req.params).id))));
router.get("/settings/roundup", handle(async (_req, res) => void res.json(await getRoundupSchedule())));
router.put("/settings/roundup", handle(async (req, res) => void res.json(await setRoundupSchedule(ScheduleBody.parse(req.body)))));

export default router;
