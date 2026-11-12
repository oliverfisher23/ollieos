/** Knowledge Inbox (features 01 and 02) and the knowledge settings. Ollie only. */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { handle } from "../lib/handle";
import { getKnowledgeSettings, resolveFactReview, runFactCheck, updateShelfLives } from "../services/factReviews";
import { listInbox, PRESORT_FILTERS } from "../services/knowledgeInbox";
import { mergeHinted, presortCards } from "../services/presort";
import { checkStaleFacts, confirmFoundStillTrue } from "../services/staleCheck";
import { approveSuggestion, approveWithPeople, bulkDecide, rejectFromSource, rejectSuggestion } from "../services/suggestions";
import { MERGE_ITEM_TYPES, mergeOptions, mergeSuggestion } from "../services/inboxMerge";

const router: IRouter = Router();

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const TabQuery = z.object({ tab: z.enum(["suggested", "conflicts", "stale"]).default("suggested"), origin: z.enum(["all", "look_back", "documents"]).default("all"), hint: z.enum(PRESORT_FILTERS).default("all") });
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
    res.json(await listInbox(q.tab, q.origin, q.hint));
  }),
);
router.post(
  "/suggestions/:id/approve",
  handle(async (req, res) => {
    const b = ApproveBody.parse(req.body ?? {});
    res.json(await approveSuggestion(IdParams.parse(req.params).id, b.fields, new Date(), { projectId: b.projectId, newProjectName: b.newProjectName }));
  }),
);
// Section 25: approve a New organisation card together with the New person cards waiting on it.
router.post("/suggestions/:id/approve-with-people", handle(async (req, res) => void res.json(await approveWithPeople(IdParams.parse(req.params).id))));
router.post(
  "/suggestions/bulk",
  handle(async (req, res) => {
    const b = z.object({ action: z.enum(["approve", "reject", "same"]), ids: z.array(z.number().int().positive()).min(1).max(500) }).strict().parse(req.body ?? {});
    if (b.action === "same") {
      // Section 23: each card merged into the approved item its pre-sort hint names.
      const r = await mergeHinted(b.ids);
      res.json({ approved: 0, rejected: 0, merged: r.merged, skipped: r.skipped });
      return;
    }
    res.json({ ...(await bulkDecide(b.action, b.ids)), merged: 0 });
  }),
);
// Section 23: pre-sort the next cards now rather than waiting for the next check.
router.post("/suggestions/presort", handle(async (_req, res) => void res.json(await presortCards())));
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
// Section 23: the stale fact checker, run now; and confirm every fact it found still true.
router.post("/fact-reviews/check-evidence", handle(async (_req, res) => void res.json(await checkStaleFacts())));
router.post("/fact-reviews/confirm-found", handle(async (_req, res) => void res.json(await confirmFoundStillTrue())));
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
