import { Router, type IRouter, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildScope } from "../lib/ai-data";
import { logger } from "../lib/logger";
import { mcpAuth } from "../middlewares/mcpAuth";
import { buildMcpServer } from "./server";

/**
 * POST /mcp: Streamable HTTP in stateless mode. Each request gets its own server and transport,
 * scoped to the AI client behind the access token, so nothing is held between requests.
 */
const router: IRouter = Router();
router.use(mcpAuth);

router.post("/", async (req: Request, res: Response) => {
  const client = req.aiClient!;
  const scope = await buildScope(client);
  const { server } = buildMcpServer(scope, { actor: client.name, clientId: client.id });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error({ err, clientId: client.id }, "MCP request failed");
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
});

/** No server-to-client stream and no sessions in stateless mode. */
const notAllowed = (_req: Request, res: Response) => {
  res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null });
};
router.get("/", notAllowed);
router.delete("/", notAllowed);

export default router;
