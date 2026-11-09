import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import mcpRouter from "./mcp/router";
import { wellKnownRouter } from "./oauth/routes";
import { logger } from "./lib/logger";
import { authMiddleware } from "./middlewares/authMiddleware";

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
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// MCP and OAuth discovery use OAuth bearer tokens, never the app's session, so they sit before it.
app.use("/.well-known", wellKnownRouter);
app.use("/mcp", mcpRouter);

app.use(authMiddleware);
app.use("/api", router);

app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const status = (err as { status?: number })?.status;
  if (status && status >= 400 && status < 500) {
    res.status(status).json({ error: "The request could not be read" });
    return;
  }
  req.log.error({ err }, "Unhandled error");
  res.status(500).json({ error: "Something went wrong" });
});

export default app;
