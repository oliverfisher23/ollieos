import { Router, type IRouter } from "express";
import { z } from "zod";
import { MUTE_MATCH_TYPES, listNoiseRules, muteRule, setNoiseRuleEnabled } from "../services/noiseRules";
import { NotFoundError, ValidationError } from "../services/tasks";
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

// Mute from Messages: stop showing a sender's email or a Slack channel's mentions. Undo turns the rule off.
router.post(
  "/noise-rules",
  handle(async (req, res) => {
    const b = z.object({ matchType: z.enum(MUTE_MATCH_TYPES), matchValue: z.string().min(1).max(200) }).strict().parse(req.body ?? {});
    const made = await muteRule(b.matchType, b.matchValue, "ollie");
    if (!made) throw new ValidationError("That cannot be muted");
    res.status(made.created ? 201 : 200).json(made);
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
