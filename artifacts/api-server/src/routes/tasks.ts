import { Router, type IRouter } from "express";
import { handle } from "../lib/handle";
import { z } from "zod";
import { TASK_SOURCES, TASK_STATUSES, PRIORITIES, TASK_KINDS, isIsoDate } from "@workspace/shared";
import {
  buildDraftPrompt,
  getTask,
  getTaskSummary,
  listTasks,
  quickAddTask,
  snoozeTask,
  updateTask,
} from "../services/tasks";
import { getTaskHistory } from "../services/history";
import { keepTask } from "../services/noiseCheck";
import { getReplyDraft, saveReplyDraftToGmail, writeReplyDraft } from "../services/replyDraft";
import { NOISE_MATCH_TYPES } from "../services/noiseRules";
import {
  buildChaseLine,
  buildWeeklyUpdate,
  getNoiseRuleOptionsFor,
  restoreFromNoise,
  triageTask,
  undoLast,
} from "../services/triage";

const router: IRouter = Router();

const ACTOR = "ollie";

const isoDate = z.string().refine(isIsoDate, "Use a YYYY-MM-DD date");

const ListQuery = z.object({
  tab: z.enum(["inbox", "open", "now", "backlog", "waiting", "done", "noise", "dropped"]).optional(),
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
    goalId: z.number().int().positive().nullable().optional(),
    notGoalWork: z.boolean().optional(),
  })
  .strict();

const TriageBody = z
  .object({
    action: z.enum(["now", "backlog", "waiting", "noise", "dropped"]),
    waitingOnPersonId: z.number().int().positive().nullable().optional(),
    noiseRule: z
      .object({
        matchType: z.enum(NOISE_MATCH_TYPES),
        matchValue: z.string().trim().min(1, "A rule needs something to match").max(200),
      })
      .strict()
      .optional(),
  })
  .strict();

const WeeklyQuery = z.object({ weekStart: isoDate.optional() });

const ReplyDraftBody = z
  .object({
    to: z.string().max(2000),
    cc: z.string().max(2000),
    subject: z.string().max(500),
    body: z.string().trim().min(1, "Write something to save").max(20000),
  })
  .strict();

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
  "/tasks/weekly-update",
  handle(async (req, res) => {
    const q = WeeklyQuery.parse(req.query);
    res.json(await buildWeeklyUpdate(q.weekStart));
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
  "/tasks/:id/keep",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    res.json(await keepTask(id, ACTOR));
  }),
);

router.get(
  "/tasks/:id/reply-draft",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    res.json({ draft: await getReplyDraft(id) });
  }),
);

router.post(
  "/tasks/:id/reply-draft",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    res.json(await writeReplyDraft(id, ACTOR));
  }),
);

router.post(
  "/tasks/:id/reply-draft/gmail",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    res.json(await saveReplyDraftToGmail(id, ReplyDraftBody.parse(req.body), ACTOR));
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

router.post(
  "/tasks/:id/triage",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    const body = TriageBody.parse(req.body);
    res.json(await triageTask(id, body, ACTOR));
  }),
);

router.post(
  "/tasks/:id/undo",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    res.json(await undoLast(id, ACTOR));
  }),
);

router.post(
  "/tasks/:id/restore",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    res.json(await restoreFromNoise(id, ACTOR));
  }),
);

router.get(
  "/tasks/:id/chase-line",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    res.json({ text: await buildChaseLine(id) });
  }),
);

router.get(
  "/tasks/:id/noise-rule-options",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    res.json(await getNoiseRuleOptionsFor(id));
  }),
);

export default router;
