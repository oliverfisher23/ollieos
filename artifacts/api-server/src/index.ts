import app from "./app";
import { logger } from "./lib/logger";
import { ensureSeeds } from "./services/seeds";
import { runMigrations } from "./services/migrations";
import { startConnectorTimer } from "./services/connectors";
import { startKnowledgeReader } from "./services/documents/reader";
import { startScheduledWorkQueue } from "./services/scheduledWorkQueue";

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

// Data changes run before the first request, so nothing reads data in its old shape.
await runMigrations().catch((e) => logger.error({ err: e }, "A start-up data change failed"));

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  ensureSeeds().catch((e) => logger.error({ err: e }, "Could not create the first goals and rules"));
  startConnectorTimer();
  startKnowledgeReader();
  startScheduledWorkQueue();
});
