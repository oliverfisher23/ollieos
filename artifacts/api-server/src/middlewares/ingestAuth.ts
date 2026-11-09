import type { NextFunction, Request, Response } from "express";
import { markClientUsed, sweepClient } from "../lib/ai-data";
import { safeEqual } from "../oauth/util";
import { bearer } from "./mcpAuth";

/**
 * Guards /api/ingest. The key is INBOX_API_KEY; the caller acts as the "Capture sweep" client,
 * so revoking that client in Settings turns ingest off.
 */
export async function ingestAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const key = process.env.INBOX_API_KEY;
  if (!key) {
    res.status(503).json({ error: "Ingest is not set up yet: INBOX_API_KEY is missing." });
    return;
  }
  const token = bearer(req);
  if (!token || !safeEqual(token, key)) {
    res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
    return;
  }
  const client = await sweepClient();
  if (client.revokedAt) {
    res.status(401).json({ error: "The Capture sweep has been revoked in Settings." });
    return;
  }
  req.aiClient = { id: client.id, name: client.name };
  await markClientUsed(client.id);
  next();
}
