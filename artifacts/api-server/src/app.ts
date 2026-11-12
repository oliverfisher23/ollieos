import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";
import { authMiddleware } from "./middlewares/authMiddleware";
import mcpRouter from "./mcp/route";
import { wellKnownRouter } from "./oauth/routes";

const app: Express = express();

app.set("trust proxy", true);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ credentials: true, origin: true }));
app.use(cookieParser());
// Uploaded files arrive as base64 in JSON, so that one route takes up to 15 MB files.
app.use("/api/documents/upload", express.json({ limit: "22mb" }));
// A LinkedIn Connections.csv for a large network is a few MB of text.
app.use("/api/contacts/linkedin-import", express.json({ limit: "12mb" }));
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(authMiddleware);

app.use("/api", router);
// AI connectors: OAuth discovery at the root, and the MCP endpoint (bearer tokens, no cookies).
app.use(wellKnownRouter);
app.use(mcpRouter);

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  req.log.error({ err }, "Unhandled error");
  res.status(500).json({ error: "Something went wrong" });
});

export default app;
