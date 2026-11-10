/** The research agent: what it found about outside companies, and starting research by hand. Ollie only. */
import { Router, type IRouter } from "express";
import { z } from "zod";
import { handle } from "../lib/handle";
import { cleanDomain, researchViews, startResearch } from "../services/research";

const router: IRouter = Router();

const StartBody = z.object({ domain: z.string().min(3).max(253), organisationId: z.number().int().positive().optional() }).strict();
const ListQuery = z.object({ domains: z.string().min(3).max(4000) });

router.get(
  "/research",
  handle(async (req, res) => {
    const q = ListQuery.parse(req.query);
    const domains = [...new Set(q.domains.split(",").filter(Boolean).map(cleanDomain))].slice(0, 20);
    res.json({ items: await researchViews(domains) });
  }),
);
router.post(
  "/research",
  handle(async (req, res) => {
    const b = StartBody.parse(req.body ?? {});
    res.json(await startResearch(b.domain, { organisationId: b.organisationId }));
  }),
);

export default router;
