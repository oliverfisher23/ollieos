import { Router, type IRouter } from "express";
import { z } from "zod";
import { handle } from "../lib/handle";
import { allowForTurn, ask, bundleTasks, draftReply, getThread, listRecentThreads, undoBundle } from "../services/ask/ask";

const router: IRouter = Router();

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const AskBody = z
  .object({
    question: z.string().trim().min(1, "Ask a question first").max(1000),
    parentId: z.number().int().positive().nullable().optional(),
  })
  .strict();
const BundleBody = z.object({ title: z.string().max(500).optional() }).strict();

router.get("/ask", handle(async (_req, res) => void res.json(await listRecentThreads())));
router.post("/ask", handle(async (req, res) => {
  const body = AskBody.parse(req.body);
  res.status(201).json(await ask(body.question, body.parentId));
}));
router.get("/ask/:id", handle(async (req, res) => void res.json(await getThread(IdParams.parse(req.params).id))));
router.post("/ask/:id/allow", handle(async (req, res) => void res.json(await allowForTurn(IdParams.parse(req.params).id))));
router.post("/ask/:id/draft", handle(async (req, res) => void res.json(await draftReply(IdParams.parse(req.params).id))));
router.post(
  "/ask/:id/bundle",
  handle(async (req, res) => void res.json(await bundleTasks(IdParams.parse(req.params).id, BundleBody.parse(req.body ?? {}).title))),
);
router.post("/ask/:id/bundle/undo", handle(async (req, res) => void res.json(await undoBundle(IdParams.parse(req.params).id))));

export default router;
