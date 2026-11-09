import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import {
  AiError,
  NO_INGEST_GRANTS,
  cursor,
  finishSweep,
  ingestDone,
  ingestNoiseRules,
  ingestOpenTasks,
  ingestTasks,
  ingestWriter,
  logActivity,
  replaceCalendar,
  startSweep,
  type ActivityInput,
  type CalendarEventInput,
  type IngestClient,
} from "../../lib/ai-data";
import { ingestAuth } from "../../middlewares/ingestAuth";

/**
 * The ingest API (PRD 12, build plan 4.3). For the scheduled Claude sweep and any script.
 * Every call needs Bearer INBOX_API_KEY and acts as the Capture sweep client.
 * This folder reads and writes only through lib/ai-data.
 */
const router: IRouter = Router();
router.use(ingestAuth);

const client = (req: Request): IngestClient => req.aiClient!;

type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await fn(req, res));
  } catch (err) {
    if (err instanceof AiError) res.status(400).json(err.toJSON());
    else next(err);
  }
};

router.post(
  "/tasks",
  wrap(async (req) => ({ results: await ingestTasks(client(req), req.body?.items) })),
);

router.get("/cursor", wrap(async () => cursor()));

router.post(
  "/sweep-run",
  wrap(async (req) => {
    const b = req.body ?? {};
    if (b.action === "start") return startSweep(client(req), b.started_at);
    if (b.action === "finish") return finishSweep(client(req), b);
    throw new AiError("invalid_input", 'action must be "start" or "finish".');
  }),
);

router.post(
  "/calendar",
  wrap(async (req) => {
    const events = req.body?.events;
    if (!Array.isArray(events) || events.length > 500) throw new AiError("invalid_input", "Send { events: [...] } with at most 500 events.");
    return replaceCalendar(ingestWriter(client(req)), events as CalendarEventInput[], { grants: NO_INGEST_GRANTS, visibleOnly: false });
  }),
);

const ACTIVITY_KINDS = ["email", "meeting", "slack", "note", "task"];

router.post(
  "/activity",
  wrap(async (req) => {
    const entries = req.body?.entries;
    if (!Array.isArray(entries) || entries.length > 200) throw new AiError("invalid_input", "Send { entries: [...] } with at most 200 entries.");
    const results = [];
    for (const e of entries as ActivityInput[]) {
      if (!e || !ACTIVITY_KINDS.includes(e.kind)) {
        results.push({ source_ref: e?.source_ref ?? null, outcome: "error", error: `kind must be one of ${ACTIVITY_KINDS.join(", ")}` });
        continue;
      }
      try {
        const r = await logActivity(ingestWriter(client(req)), e, { grants: NO_INGEST_GRANTS, visibleOnly: false });
        results.push({ source_ref: e.source_ref ?? null, outcome: r.duplicate ? "duplicate" : "created", ...r });
      } catch (err) {
        results.push({ source_ref: e.source_ref ?? null, outcome: "error", error: err instanceof Error ? err.message : "Could not save this entry" });
      }
    }
    return { results };
  }),
);

router.get("/noise-rules", wrap(async () => ingestNoiseRules()));
router.get("/open-tasks", wrap(async (req) => ingestOpenTasks(client(req))));
router.get(
  "/done",
  wrap(async (req) => ingestDone(client(req), typeof req.query.since === "string" ? req.query.since : undefined)),
);

export default router;
