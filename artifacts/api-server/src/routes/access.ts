import { Router, type IRouter } from "express";
import { z } from "zod";
import { handle } from "../lib/handle";
import {
  aiAccessSummary,
  approveRequest,
  declineRequest,
  endAccess,
  listAccessRequests,
  listAiActivity,
  listAiClients,
} from "../services/access";
import { reconnectClient, revokeClient, sweepStatus } from "../services/clients";

const router: IRouter = Router();

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const ApproveBody = z
  .object({
    entityType: z.enum(["project", "person", "organisation", "task", "decision", "note"]).optional(),
    entityId: z.number().int().positive().optional(),
  })
  .strict();
const ActivityQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() });

router.get("/access-requests", handle(async (_req, res) => void res.json(await listAccessRequests())));
router.post(
  "/access-requests/:id/approve",
  handle(async (req, res) => void res.json(await approveRequest(IdParams.parse(req.params).id, ApproveBody.parse(req.body ?? {})))),
);
router.post("/access-requests/:id/decline", handle(async (req, res) => void res.json(await declineRequest(IdParams.parse(req.params).id))));
router.post("/access-requests/:id/end", handle(async (req, res) => void res.json(await endAccess(IdParams.parse(req.params).id))));
router.get("/ai-clients", handle(async (_req, res) => void res.json(await listAiClients())));
router.post("/ai-clients/:id/revoke", handle(async (req, res) => void res.json(await revokeClient(IdParams.parse(req.params).id))));
router.post("/ai-clients/:id/reconnect", handle(async (req, res) => void res.json(await reconnectClient(IdParams.parse(req.params).id))));
router.get("/sweep", handle(async (_req, res) => void res.json(await sweepStatus())));
router.get("/ai-access/summary", handle(async (_req, res) => void res.json(await aiAccessSummary())));
router.get("/ai-activity", handle(async (req, res) => void res.json(await listAiActivity(ActivityQuery.parse(req.query).limit ?? 100))));

export default router;
