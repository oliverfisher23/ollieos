import { Router, type IRouter } from "express";
import { z } from "zod";
import { isIsoDate } from "@workspace/shared";
import { handle } from "../lib/handle";
import { createGoal, goalOptions, listGoals, updateGoal } from "../services/goals";

const router: IRouter = Router();

const isoDate = z.string().refine(isIsoDate, "Use a YYYY-MM-DD date");
const IdParams = z.object({ id: z.coerce.number().int().positive() });

const GoalCreate = z
  .object({
    name: z.string().min(1).max(200),
    parentId: z.number().int().positive().nullable().optional(),
    statement: z.string().max(2000).nullable().optional(),
    targetText: z.string().max(2000).nullable().optional(),
    periodStart: isoDate.nullable().optional(),
    periodEnd: isoDate.nullable().optional(),
    confidential: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10000).optional(),
  })
  .strict();
const GoalUpdate = GoalCreate.partial().strict();

router.get("/goals", handle(async (_req, res) => void res.json(await listGoals())));
router.get("/goals/options", handle(async (_req, res) => void res.json(await goalOptions())));
router.post("/goals", handle(async (req, res) => void res.status(201).json(await createGoal(GoalCreate.parse(req.body)))));
router.patch("/goals/:id", handle(async (req, res) => void res.json(await updateGoal(IdParams.parse(req.params).id, GoalUpdate.parse(req.body)))));

export default router;
