import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { TASK_SOURCES, TASK_STATUSES, PRIORITIES, TASK_KINDS, isIsoDate } from "@workspace/shared";
import {
  NotFoundError,
  ValidationError,
  buildDraftPrompt,
  getTask,
  getTaskSummary,
  listTasks,
  quickAddTask,
  snoozeTask,
  updateTask,
} from "../services/tasks";
import { getTaskHistory } from "../services/history";

const router: IRouter = Router();

const ACTOR = "ollie";

const isoDate = z.string().refine(isIsoDate, "Use a YYYY-MM-DD date");

const ListQuery = z.object({
  tab: z.enum(["inbox", "open", "now", "backlog", "waiting", "done", "noise"]).optional(),
  source: z.enum(TASK_SOURCES).optional(),
  weekStart: isoDate.optional(),
  includeUndated: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  q: z.string().max(200).optional(),
});

const SummaryQuery = z.object({ weekStart: isoDate.optional() });

const IdParams = z.object({ id: z.coerce.number().int().positive() });

const QuickAddBody = z.object({ text: z.string().min(1).max(500) });

const UpdateBody = z
  .object({
    title: z.string().min(1).max(500).optional(),
    kind: z.enum(TASK_KINDS).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    dueDate: isoDate.nullable().optional(),
    notes: z.string().max(20000).nullable().optional(),
    projectId: z.number().int().positive().nullable().optional(),
    personId: z.number().int().positive().nullable().optional(),
    waitingOnPersonId: z.number().int().positive().nullable().optional(),
    confidential: z.boolean().nullable().optional(),
  })
  .strict();

type Handler = (req: Request, res: Response) => Promise<void>;

/** Turns validation and not-found errors into clear 4xx responses. */
function handle(fn: Handler) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof z.ZodError) {
        res.status(400).json({ error: err.issues.map((i) => i.message).join("; ") });
      } else if (err instanceof ValidationError) {
        res.status(400).json({ error: err.message });
      } else if (err instanceof NotFoundError) {
        res.status(404).json({ error: err.message });
      } else {
        next(err);
      }
    }
  };
}

router.get(
  "/tasks",
  handle(async (req, res) => {
    const q = ListQuery.parse(req.query);
    res.json(await listTasks(q));
  }),
);

router.get(
  "/tasks/summary",
  handle(async (req, res) => {
    const q = SummaryQuery.parse(req.query);
    res.json(await getTaskSummary(q.weekStart));
  }),
);

router.post(
  "/tasks/quick-add",
  handle(async (req, res) => {
    const body = QuickAddBody.parse(req.body);
    res.status(201).json(await quickAddTask(body.text, ACTOR));
  }),
);

router.get(
  "/tasks/:id",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    const task = await getTask(id);
    res.json({ task, history: await getTaskHistory(id) });
  }),
);

router.patch(
  "/tasks/:id",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    const body = UpdateBody.parse(req.body);
    res.json(await updateTask(id, body, ACTOR));
  }),
);

router.post(
  "/tasks/:id/snooze",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    res.json(await snoozeTask(id, ACTOR));
  }),
);

router.get(
  "/tasks/:id/draft-prompt",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    res.json({ text: await buildDraftPrompt(id) });
  }),
);

export default router;
