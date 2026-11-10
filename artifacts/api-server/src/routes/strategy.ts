import { Router, type IRouter } from "express";
import { z } from "zod";
import { isIsoDate } from "@workspace/shared";
import { handle } from "../lib/handle";
import {
  IDEA_TABS,
  createIdea,
  createSection,
  deleteIdea,
  deleteSection,
  getIdea,
  listIdeas,
  listSections,
  reorderSections,
  restoreIdea,
  restoreSection,
  takeIdeaForward,
  updateIdea,
  updateSection,
} from "../services/strategy";

/** Strategy and ideas (build plan Part H): Ollie's own; Claude only reads them and adds ideas over MCP. */
const router: IRouter = Router();

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const isoDate = z.string().refine(isIsoDate, "Use a YYYY-MM-DD date");
const ids = z.array(z.number().int().positive()).max(50);

const SectionCreate = z
  .object({
    name: z.string().min(1).max(200),
    body: z.string().max(50_000).optional(),
    goalIds: ids.optional(),
    projectIds: ids.optional(),
    confidential: z.boolean().optional(),
    aiAccess: z.boolean().optional(),
  })
  .strict();
const SectionUpdate = SectionCreate.partial().strict();
const Reorder = z.object({ ids: z.array(z.number().int().positive()).max(200) }).strict();

const IdeaCreate = z
  .object({
    title: z.string().min(1).max(300),
    notes: z.string().max(50_000).nullable().optional(),
    status: z.enum(["new", "come_back", "dropped"]).optional(),
    comeBackOn: isoDate.nullable().optional(),
    goalId: z.number().int().positive().nullable().optional(),
    projectId: z.number().int().positive().nullable().optional(),
    confidential: z.boolean().optional(),
    aiAccess: z.boolean().optional(),
  })
  .strict();
const IdeaUpdate = IdeaCreate.partial().strict();
const IdeaQuery = z.object({ status: z.enum(IDEA_TABS).optional(), q: z.string().max(300).optional() });
const TakeForward = z.object({ as: z.enum(["task", "project"]) }).strict();

router.get("/strategy/sections", handle(async (_req, res) => void res.json(await listSections())));
router.post("/strategy/sections", handle(async (req, res) => void res.status(201).json(await createSection(SectionCreate.parse(req.body)))));
router.put("/strategy/sections/order", handle(async (req, res) => void res.json(await reorderSections(Reorder.parse(req.body).ids))));
router.patch("/strategy/sections/:id", handle(async (req, res) => void res.json(await updateSection(IdParams.parse(req.params).id, SectionUpdate.parse(req.body)))));
router.post("/strategy/sections/:id/restore", handle(async (req, res) => void res.json(await restoreSection(IdParams.parse(req.params).id))));
router.delete(
  "/strategy/sections/:id",
  handle(async (req, res) => {
    await deleteSection(IdParams.parse(req.params).id);
    res.status(204).end();
  }),
);

router.get("/ideas", handle(async (req, res) => void res.json(await listIdeas(IdeaQuery.parse(req.query)))));
router.post("/ideas", handle(async (req, res) => void res.status(201).json(await createIdea(IdeaCreate.parse(req.body)))));
router.get("/ideas/:id", handle(async (req, res) => void res.json(await getIdea(IdParams.parse(req.params).id))));
router.patch("/ideas/:id", handle(async (req, res) => void res.json(await updateIdea(IdParams.parse(req.params).id, IdeaUpdate.parse(req.body)))));
router.post("/ideas/:id/forward", handle(async (req, res) => void res.json(await takeIdeaForward(IdParams.parse(req.params).id, TakeForward.parse(req.body).as))));
router.post("/ideas/:id/restore", handle(async (req, res) => void res.json(await restoreIdea(IdParams.parse(req.params).id))));
router.delete(
  "/ideas/:id",
  handle(async (req, res) => {
    await deleteIdea(IdParams.parse(req.params).id);
    res.status(204).end();
  }),
);

export default router;
