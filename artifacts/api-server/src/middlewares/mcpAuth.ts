import type { NextFunction, Request, Response } from "express";
import { markClientUsed } from "../lib/ai-data";
import { clientForAccessToken } from "../oauth/store";
import { resourceMetadataUrl } from "../oauth/util";

declare global {
  namespace Express {
    interface Request {
      /** The AI client behind an MCP or ingest request */
      aiClient?: { id: number; name: string };
    }
  }
}

function bearer(req: Request): string | null {
  const h = req.get("authorization");
  const m = h ? /^Bearer\s+(\S+)$/i.exec(h.trim()) : null;
  return m ? m[1] : null;
}

/**
 * Guards /mcp. Without a live access token the reply is 401 with a WWW-Authenticate header
 * naming the protected resource metadata, which is how Claude finds the OAuth server.
 */
export async function mcpAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = bearer(req);
  const client = token ? await clientForAccessToken(token) : null;
  if (!client) {
    const parts = [`resource_metadata="${resourceMetadataUrl(req)}"`];
    if (token) parts.unshift('error="invalid_token"', 'error_description="The access token is invalid, expired or revoked"');
    res.status(401).set("WWW-Authenticate", `Bearer ${parts.join(", ")}`).json({ error: "unauthorized" });
    return;
  }
  req.aiClient = client;
  await markClientUsed(client.id);
  next();
}

export { bearer };
