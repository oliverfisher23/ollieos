/** Knowledge Inbox (features 01 and 02) and the knowledge settings. Ollie only. */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { handle } from "../lib/handle";
import { getKnowledgeSettings, resolveFactReview, runFactCheck, updateShelfLives } from "../services/factReviews";
import { listInbox } from "../services/knowledgeInbox";
import { approveSuggestion, bulkDecide, rejectFromSource, rejectSuggestion } from "../services/suggestions";
import { MERGE_ITEM_TYPES, mergeOptions, mergeSuggestion } from "../services/inboxMerge";

const router: IRouter = Router();

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const TabQuery = z.object({ tab: z.enum(["suggested", "conflicts", "stale"]).default("suggested"), origin: z.enum(["all", "look_back", "documents"]).default("all") });
const RejectSourceBody = z.object({ sourceRef: z.string().min(1).max(1200) }).strict();
const ApproveBody = z
  .object({
    fields: z.record(z.string(), z.string().max(5000)).optional(),
    projectId: z.number().int().positive().optional(),
    newProjectName: z.string().trim().min(1).max(200).optional(),
  })
  .strict();
const MergeBody = z.object({ itemType: z.enum(MERGE_ITEM_TYPES), itemId: z.number().int().positive() }).strict();
const text = z.string().min(1).max(2000);
const ResolveBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("still_true") }).strict(),
  z.object({ action: z.literal("edit"), text }).strict(),
  z.object({ action: z.literal("no_longer_true") }).strict(),
  z.object({ action: z.literal("keep"), ref: z.string().max(40) }).strict(),
  z.object({ action: z.literal("write_own"), text }).strict(),
  z.object({ action: z.literal("new_right") }).strict(),
  z.object({ action: z.literal("old_stands") }).strict(),
  z.object({ action: z.literal("both_true") }).strict(),
]);
const days = z.number().int().min(1).max(3650);
const SettingsBody = z
  .object({
    shelfLifeDays: z
      .object({ general: days, status: days, next_step: days, decision_date: days, job_title: days, organisation: days, renewal_date: days, contract_value: days, account_health: days })
      .partial()
      .strict(),
  })
  .strict();

router.get(
  "/suggestions",
  handle(async (req, res) => {
    const q = TabQuery.parse(req.query);
    res.json(await listInbox(q.tab, q.origin));
  }),
);
router.post(
  "/suggestions/:id/approve",
  handle(async (req, res) => {
    const b = ApproveBody.parse(req.body ?? {});
    res.json(await approveSuggestion(IdParams.parse(req.params).id, b.fields, new Date(), { projectId: b.projectId, newProjectName: b.newProjectName }));
  }),
);
router.post(
  "/suggestions/bulk",
  handle(async (req, res) => {
    const b = z.object({ action: z.enum(["approve", "reject"]), ids: z.array(z.number().int().positive()).min(1).max(500) }).strict().parse(req.body ?? {});
    res.json(await bulkDecide(b.action, b.ids));
  }),
);
router.post(
  "/suggestions/reject-source",
  handle(async (req, res) => void res.json({ rejected: await rejectFromSource(RejectSourceBody.parse(req.body).sourceRef) })),
);
router.get("/suggestions/:id/merge-options", handle(async (req, res) => void res.json(await mergeOptions(IdParams.parse(req.params).id))));
router.post(
  "/suggestions/:id/merge",
  handle(async (req, res) => {
    const b = MergeBody.parse(req.body);
    res.json(await mergeSuggestion(IdParams.parse(req.params).id, b.itemType, b.itemId));
  }),
);
router.post("/suggestions/:id/reject", handle(async (req, res) => void res.json(await rejectSuggestion(IdParams.parse(req.params).id))));
router.post(
  "/fact-reviews/:id/resolve",
  handle(async (req, res) => {
    const r = await resolveFactReview(IdParams.parse(req.params).id, ResolveBody.parse(req.body));
    res.json({ id: r.id, status: r.status });
  }),
);

router.get("/settings/knowledge", handle(async (_req, res) => void res.json(await getKnowledgeSettings())));
router.patch("/settings/knowledge", handle(async (req, res) => void res.json(await updateShelfLives(SettingsBody.parse(req.body).shelfLifeDays))));
router.post("/settings/knowledge/check", handle(async (_req, res) => void res.json(await runFactCheck(new Date(), "ollie"))));

export default router;
