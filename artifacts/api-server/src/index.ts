import app from "./app";
import { logger } from "./lib/logger";
import { ensureSeeds } from "./services/seeds";
import { startConnectorTimer } from "./services/connectors";
import { startKnowledgeReader } from "./services/documents/reader";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  ensureSeeds().catch((e) => logger.error({ err: e }, "Could not create the first goals and playbooks"));
  startConnectorTimer();
  startKnowledgeReader();
});
