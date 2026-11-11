import { Router, type IRouter } from "express";
import healthRouter from "./health";
import authRouter from "./auth";
import homeRouter from "./home";
import tasksRouter from "./tasks";
import noiseRulesRouter from "./noiseRules";
import knowledgeRouter from "./knowledge";
import knowledgeInboxRouter from "./knowledgeInbox";
import askRouter from "./ask";
import accessRouter from "./access";
import goalsRouter from "./goals";
import libraryRouter from "./library";
import briefsRouter from "./briefs";
import connectorsRouter from "./connectors";
import reviewRouter from "./review";
import emailRouter from "./email";
import researchRouter from "./research";
import sessionsRouter from "./sessions";
import graphRouter from "./graph";
import strategyRouter from "./strategy";
import planRouter from "./plan";
import roundupsRouter from "./roundups";
import ingestRouter from "./ingest";
import { oauthConsentRouter, oauthPublicRouter } from "../oauth/routes";
import { requireOllie } from "../middlewares/requireOllie";

const router: IRouter = Router();

// Open routes: health check and the sign-in flow.
router.use(healthRouter);
router.use(authRouter);
// OAuth for AI connectors (open by design; the consent step below needs Ollie).
router.use(oauthPublicRouter);
// Ingest has its own key check (INBOX_API_KEY).
router.use(ingestRouter);

// Everything below holds Ollie's data and is allowlist-only.
router.use(requireOllie);
router.use(homeRouter);
router.use(tasksRouter);
router.use(noiseRulesRouter);
router.use(knowledgeRouter);
router.use(knowledgeInboxRouter);
router.use(askRouter);
router.use(accessRouter);
router.use(goalsRouter);
router.use(libraryRouter);
router.use(briefsRouter);
router.use(connectorsRouter);
router.use(reviewRouter);
router.use(emailRouter);
router.use(researchRouter);
router.use(sessionsRouter);
router.use(graphRouter);
router.use(strategyRouter);
router.use(planRouter);
router.use(roundupsRouter);
router.use(oauthConsentRouter);

export default router;
