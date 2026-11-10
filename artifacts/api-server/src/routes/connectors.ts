import { Router, type IRouter } from "express";
import { z } from "zod";
import { handle } from "../lib/handle";
import { INTERVALS, SERVICE_KEYS, runConnector, setReadBy, updateSchedule, type ServiceKey } from "../services/connectors";
import { ACTION_RANGES, DECISION_RANGES, getLookBack, resumeLookBack, startLookBack, stopLookBack } from "../services/connectors/lookBack";
import { connectorsView } from "../services/connectors/status";
import { scheduledWork } from "../services/scheduledWork";
import { ValidationError } from "../services/tasks";

const router: IRouter = Router();

const KeyParams = z.object({ key: z.enum(SERVICE_KEYS) });
const ScheduleBody = z
  .object({
    enabled: z.boolean().optional(),
    everyMinutes: z.union([z.literal(INTERVALS[0]), z.literal(INTERVALS[1])]).optional(),
    start: z.string().max(5).optional(),
    end: z.string().max(5).optional(),
  })
  .strict();
const inList = (list: readonly number[], message: string) => z.number().int().refine((n) => list.includes(n), message);
const LookBackBody = z
  .object({
    decisionsDays: inList(DECISION_RANGES, "Choose 1, 3, 6 or 12 months for decisions."),
    actionsDays: inList(ACTION_RANGES, "Choose none, 2 weeks, 1 month or 2 months for actions."),
  })
  .strict();
const ReadByBody = z.object({ readBy: z.enum(["ollieos", "claude"]) }).strict();

const parseKey = (params: unknown): ServiceKey => {
  const r = KeyParams.safeParse(params);
  if (!r.success) throw new ValidationError("There is no connector with that name.");
  return r.data.key;
};

/* Connectors: which services OllieOS reads itself, and when it checks them. */
router.get("/connectors", handle(async (_req, res) => void res.json(await connectorsView())));

router.patch(
  "/connectors/schedule",
  handle(async (req, res) => {
    await updateSchedule(ScheduleBody.parse(req.body ?? {}));
    res.json(await connectorsView());
  }),
);

/* Look back at Granola: a one-off read of older meeting notes, in the background. */
router.get("/connectors/granola/look-back", handle(async (_req, res) => void res.json(await getLookBack())));
router.post("/connectors/granola/look-back", handle(async (req, res) => void res.json(await startLookBack(LookBackBody.parse(req.body ?? {})))));
router.post("/connectors/granola/look-back/stop", handle(async (_req, res) => void res.json(await stopLookBack())));
router.post("/connectors/granola/look-back/resume", handle(async (_req, res) => void res.json(await resumeLookBack())));

router.patch(
  "/connectors/:key",
  handle(async (req, res) => {
    await setReadBy(parseKey(req.params), ReadByBody.parse(req.body ?? {}).readBy);
    res.json(await connectorsView());
  }),
);

router.post(
  "/connectors/:key/check",
  handle(async (req, res) => {
    const run = await runConnector(parseKey(req.params), "manual");
    if (run.ok) await scheduledWork("connectors");
    res.json({ ok: run.ok, found: run.found, counts: run.counts, account: run.account, error: run.error, needsReconnect: run.needsReconnect });
  }),
);

export default router;
