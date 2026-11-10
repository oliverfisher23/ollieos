import { Router, type IRouter } from "express";
import { z } from "zod";
import { handle } from "../lib/handle";
import { INTERVALS, SERVICE_KEYS, runConnector, setDropboxFolder, setReadBy, updateSchedule, type ServiceKey } from "../services/connectors";
import { countReadable, normaliseFolder } from "../services/connectors/dropbox";
import { retryFailedDropbox } from "../services/documents/reader";
import { logger } from "../lib/logger";
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
const DropboxFolderBody = z.object({ folder: z.string().min(1).max(500), existing: z.enum(["all", "new"]) }).strict();
const DropboxPreviewBody = z.object({ folder: z.string().min(1).max(500) }).strict();

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

/* Dropbox: Claude's folder, read only for the knowledge step. */
router.post(
  "/connectors/dropbox/preview",
  handle(async (req, res) => {
    const folder = normaliseFolder(DropboxPreviewBody.parse(req.body ?? {}).folder);
    if (!folder) throw new ValidationError("Choose a folder inside Dropbox, for example /Cowork/Springpod.");
    const found = await countReadable(folder);
    if (!found) throw new ValidationError(`There is no folder called ${folder} in Dropbox.`);
    res.json({ folder, readable: found.readable, other: found.other });
  }),
);
router.put(
  "/connectors/dropbox/folder",
  handle(async (req, res) => {
    const b = DropboxFolderBody.parse(req.body ?? {});
    await setDropboxFolder(b.folder, b.existing);
    // List the folder straight away rather than waiting for the next timed check.
    void runConnector("dropbox", "manual").catch((err) => logger.error({ err }, "Dropbox check after choosing the folder failed"));
    res.json(await connectorsView());
  }),
);
router.post(
  "/connectors/dropbox/retry",
  handle(async (_req, res) => {
    await retryFailedDropbox();
    res.json(await connectorsView());
  }),
);

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
