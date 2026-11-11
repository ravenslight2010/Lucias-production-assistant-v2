import app from "./app";
import { logger } from "./lib/logger";
import { configuredPoolMax, pool } from "@workspace/db";
import { attachDbPoolMetrics } from "./lib/db-pool-metrics";

const poolMetrics = attachDbPoolMetrics({
  pool,
  service: "api",
  configuredPoolMax,
  logger,
});

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

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port, dbPoolMax: configuredPoolMax }, "API server listening");
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down API server");
  const timeout = setTimeout(() => {
    logger.error({ signal }, "Graceful shutdown timed out");
    process.exit(1);
  }, 10_000);
  timeout.unref();

  server.close(async (error) => {
    if (error) logger.error({ err: error, signal }, "HTTP server close failed");
    try {
      await pool.end();
      poolMetrics.observeShutdown();
      clearTimeout(timeout);
      process.exit(error ? 1 : 0);
    } catch (poolError) {
      logger.error({ err: poolError, signal }, "Database pool close failed");
      process.exit(1);
    }
  });
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
