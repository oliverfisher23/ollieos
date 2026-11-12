import { dismissDelegateHint } from "../services/delegation";
import { dmOptions, MAX_DM, sendSlackDm } from "../services/slackDm";
import { Router, type IRouter } from "express";
import { checkDraft, taskContextRefs } from "../services/draftLearning";
import { handle } from "../lib/handle";
import { z } from "zod";
import { DROP_REASONS, REPEAT_EVERY, TASK_SOURCES, TASK_STATUSES, PRIORITIES, TASK_KINDS, isIsoDate } from "@workspace/shared";
import { projectSuggestionsFor } from "../services/projectSuggest";
import { dismissStuckHint } from "../services/stuckCoach";
import {
  MAX_STEPS,
  buildDraftPrompt,
  continueRepeat,
  getTask,
  getTaskSummary,
  listTasks,
  quickAddTask,
  bulkUpdate,
  chaseLater,
  reorderTasks,
  snoozeTask,
  updateTask,
} from "../services/tasks";
import { getTaskHistory } from "../services/history";
import { dismissDuplicate, findDuplicates, listDuplicates, mergeDuplicate } from "../services/duplicates";
import { keepTask } from "../services/noiseCheck";
import { dismissEvidence, listEvidence } from "../services/taskEvidence";
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
  tab: z.enum(["inbox", "open", "now", "backlog", "waiting", "done", "noise", "dropped", "archived"]).optional(),
  source: z.enum(TASK_SOURCES).optional(),
  weekStart: isoDate.optional(),
  includeUndated: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  q: z.string().max(200).optional(),
  due: z.union([z.literal("overdue"), isoDate]).optional(),
});

const SummaryQuery = z.object({ weekStart: isoDate.optional() });

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const WriteReplyBody = z
  .object({
    instructions: z.string().max(2000).optional(),
    current: z.string().max(20000).optional(),
  })
  .strict();

const QuickAddBody = z.object({ text: z.string().min(1).max(500) });

const ReorderBody = z
  .object({
    ids: z.array(z.number().int().positive()).min(1).max(500),
    clear: z.boolean().optional(),
  })
  .strict();

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
    repeat: z
      .object({ every: z.enum(REPEAT_EVERY), byWeekday: z.boolean().optional() })
      .strict()
      .nullable()
      .optional(),
    steps: z
      .array(z.object({ id: z.string().max(40), title: z.string().max(300), done: z.boolean() }).strict())
      .max(MAX_STEPS)
      .optional(),
    dropReason: z.enum(DROP_REASONS).nullable().optional(),
  })
  .strict();

const BulkBody = z
  .object({
    ids: z.array(z.number().int().positive()).min(1).max(200),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(PRIORITIES).optional(),
    dueDate: isoDate.nullable().optional(),
    projectId: z.number().int().positive().nullable().optional(),
    dropReason: z.enum(DROP_REASONS).nullable().optional(),
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

const PairParams = z.object({ pairId: z.coerce.number().int().positive() });
const MergeBody = z.object({ keep: z.number().int().positive() }).strict();

// Section 26: the Duplicates page. Registered before /tasks/:id so "duplicates" is never read as an id.
router.get(
  "/tasks/duplicates",
  handle(async (_req, res) => {
    res.json({ pairs: await listDuplicates() });
  }),
);

router.post(
  "/tasks/duplicates/check",
  handle(async (_req, res) => {
    res.json(await findDuplicates());
  }),
);

router.post(
  "/tasks/duplicates/:pairId/merge",
  handle(async (req, res) => {
    const { pairId } = PairParams.parse(req.params);
    const body = MergeBody.parse(req.body);
    res.json(await mergeDuplicate(pairId, body.keep, ACTOR));
  }),
);

router.post(
  "/tasks/duplicates/:pairId/dismiss",
  handle(async (req, res) => {
    const { pairId } = PairParams.parse(req.params);
    await dismissDuplicate(pairId);
    res.status(204).end();
  }),
);

// Section 27: the same change to several tasks.
router.post(
  "/tasks/bulk",
  handle(async (req, res) => {
    const { ids, ...patch } = BulkBody.parse(req.body);
    res.json(await bulkUpdate(ids, patch, ACTOR));
  }),
);

router.post(
  "/tasks/reorder",
  handle(async (req, res) => {
    const body = ReorderBody.parse(req.body);
    await reorderTasks(body.ids, body.clear ?? false);
    res.status(204).end();
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
    res.json(await writeReplyDraft(id, ACTOR, WriteReplyBody.parse(req.body ?? {})));
  }),
);

// Part L: check a draft against the rules that apply to its task, and fix the lines that break one.
router.get(
  "/tasks/:id/slack-dm",
  handle(async (req, res) => void res.json(await dmOptions(IdParams.parse(req.params).id))),
);
router.post(
  "/tasks/:id/slack-dm",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    const b = z.object({ personId: z.number().int().positive(), text: z.string().min(1).max(MAX_DM) }).strict().parse(req.body ?? {});
    res.json(await sendSlackDm(id, b, "ollie"));
  }),
);
// Section 23: "Not this one" on the delegation suggester's colleague.
router.post(
  "/tasks/:id/delegate-hint/dismiss",
  handle(async (req, res) => void res.json(await dismissDelegateHint(IdParams.parse(req.params).id))),
);
router.post(
  "/tasks/:id/reply-draft/check",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    const b = z.object({ body: z.string().min(1).max(20000) }).strict().parse(req.body ?? {});
    res.json({ issues: await checkDraft(b.body, await taskContextRefs(id)) });
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

router.post(
  "/tasks/:id/continue-repeat",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    res.json(await continueRepeat(id, ACTOR));
  }),
);

router.get(
  "/tasks/:id/project-suggestions",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    res.json({ projects: await projectSuggestionsFor(id) });
  }),
);

router.post(
  "/tasks/:id/chase-later",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    res.json(await chaseLater(id));
  }),
);

router.post(
  "/tasks/:id/stuck/dismiss",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    await dismissStuckHint(id);
    res.json(await getTask(id));
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

// Part U: what OllieOS has seen about a task, and "Not done" on a Looks done marker.
router.get(
  "/tasks/:id/evidence",
  handle(async (req, res) => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(req.params);
    await getTask(id);
    res.json(await listEvidence(id));
  }),
);
router.post(
  "/tasks/:id/evidence/:evidenceId/dismiss",
  handle(async (req, res) => {
    const { id, evidenceId } = z.object({ id: z.coerce.number().int().positive(), evidenceId: z.coerce.number().int().positive() }).parse(req.params);
    res.json(await dismissEvidence(id, evidenceId));
  }),
);

export default router;
