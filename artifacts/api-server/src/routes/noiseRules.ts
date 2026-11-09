import { Router, type IRouter } from "express";
import { z } from "zod";
import { listNoiseRules, setNoiseRuleEnabled } from "../services/noiseRules";
import { NotFoundError } from "../services/tasks";
import { handle } from "../lib/handle";

const router: IRouter = Router();

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const UpdateBody = z.object({ enabled: z.boolean() }).strict();

router.get(
  "/noise-rules",
  handle(async (_req, res) => {
    res.json(await listNoiseRules());
  }),
);

router.patch(
  "/noise-rules/:id",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    const body = UpdateBody.parse(req.body);
    const rule = await setNoiseRuleEnabled(id, body.enabled, "ollie");
    if (!rule) throw new NotFoundError("Rule not found");
    res.json(rule);
  }),
);

export default router;
