import { Router, type IRouter } from "express";
import { z } from "zod";
import { handle } from "../lib/handle";
import { keepInBacklog } from "../services/tasks";
import { PLAN_LENGTHS, dismissClearOut, getClearOut, getPlan, getWorkingHours, refitPlan, savePlan, setWorkingHours } from "../services/planning";

/** Plan my day, the Backlog clear-out and working hours (build plan 14, Part I). */
const router: IRouter = Router();
const ACTOR = "ollie";

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const PlanBody = z
  .object({
    items: z
      .array(
        z
          .object({
            taskId: z.number().int().positive(),
            minutes: z.number().int().refine((m) => (PLAN_LENGTHS as readonly number[]).includes(m), "Lengths are 15, 30, 60 or 120 minutes"),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();
const HoursBody = z
  .object({
    start: z.string().regex(/^\d{2}:\d{2}$/, "Use a time such as 09:00"),
    end: z.string().regex(/^\d{2}:\d{2}$/, "Use a time such as 18:00"),
  })
  .strict();

router.get("/plan", handle(async (_req, res) => void res.json(await getPlan())));
router.put("/plan", handle(async (req, res) => void res.json(await savePlan(PlanBody.parse(req.body).items))));
router.post("/plan/fit", handle(async (_req, res) => void res.json(await refitPlan())));

router.get("/settings/working-hours", handle(async (_req, res) => void res.json(await getWorkingHours())));
router.put("/settings/working-hours", handle(async (req, res) => void res.json(await setWorkingHours(HoursBody.parse(req.body)))));

router.get("/backlog/clear-out", handle(async (_req, res) => void res.json(await getClearOut())));
router.post("/backlog/clear-out/dismiss", handle(async (_req, res) => void res.json(await dismissClearOut())));
router.post(
  "/backlog/clear-out/:id/keep",
  handle(async (req, res) => {
    const { id } = IdParams.parse(req.params);
    res.json(await keepInBacklog(id, ACTOR));
  }),
);

export default router;
