/** The Agents page (build plan section 21, Part V): every AI agent and connected AI. Ollie only. */
import { Router, type IRouter } from "express";
import { handle } from "../lib/handle";
import { agentsView } from "../services/agents";

const router: IRouter = Router();

router.get("/agents", handle(async (_req, res) => void res.json(await agentsView())));

export default router;
