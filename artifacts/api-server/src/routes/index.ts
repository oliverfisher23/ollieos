import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import homeRouter from "./home";
import tasksRouter from "./tasks";
import noiseRulesRouter from "./noiseRules";
import knowledgeRouter from "./knowledge";
import askRouter from "./ask";
import { requireOllie } from "../middlewares/requireOllie";

const router: IRouter = Router();

// Open routes: health check and the sign-in flow.
router.use(healthRouter);
router.use(authRouter);

// Everything below holds Ollie's data and is allowlist-only.
router.use(requireOllie);
router.use(homeRouter);
router.use(tasksRouter);
router.use(noiseRulesRouter);
router.use(knowledgeRouter);
router.use(askRouter);

export default router;
