/**
 * POST /mcp: Streamable HTTP in stateless mode, so any instance can answer any request
 * (Autoscale). Each request builds a fresh server bound to the caller's scope and live grants.
 */
import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildScope, type AiScope } from "../lib/ai-data/scope";
import { clientForAccessToken } from "../oauth/store";
import { MCP_PATH, resourceMetadataUrl } from "../oauth/routes";
import { buildMcpServer } from "./server";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      aiScope?: AiScope;
      mcpScopes?: string[];
    }
  }
}

function bearer(req: Request): string {
  const h = req.headers.authorization ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
}

/**
 * Claude only starts the OAuth flow after a 401 that carries WWW-Authenticate with the
 * resource_metadata address (Anthropic connector docs).
 */
async function requireToken(req: Request, res: Response, next: NextFunction) {
  try {
    const tokenValue = bearer(req);
    const token = tokenValue ? await clientForAccessToken(tokenValue) : null;
    if (!token) {
      const parts = [`resource_metadata="${resourceMetadataUrl(req)}"`];
      if (tokenValue) parts.push('error="invalid_token"', 'error_description="The access token is invalid, expired or revoked"');
      res.status(401).set("WWW-Authenticate", `Bearer ${parts.join(", ")}`).json({ error: "Sign in to OllieOS to use this connector" });
      return;
    }
    if (!token.scopes.includes("read")) {
      res.status(403).set("WWW-Authenticate", 'Bearer error="insufficient_scope", scope="read"').json({ error: "Read access is required" });
      return;
    }
    req.aiScope = await buildScope({ id: token.client.id, name: token.client.name });
    req.mcpScopes = token.scopes;
    next();
  } catch (err) {
    next(err);
  }
}

const router: IRouter = Router();

router.post(MCP_PATH, requireToken, async (req, res, next) => {
  const scope = req.aiScope!;
  const server = buildMcpServer(scope, { actor: scope.actor, clientId: scope.clientId }, req.mcpScopes!);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) next(err);
  }
});

// Stateless: there is no session stream to open or close.
router.get(MCP_PATH, requireToken, (_req, res) => {
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});
router.delete(MCP_PATH, requireToken, (_req, res) => {
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null });
});

export default router;
