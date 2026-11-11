import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { logger } from "./lib/logger";

type ServiceSpec = {
  name: "api" | "worker";
  entry: string;
  dbPoolMax: number;
};

const services: ServiceSpec[] = [
  {
    name: "api",
    entry: fileURLToPath(new URL("./index.mjs", import.meta.url)),
    dbPoolMax: 4,
  },
  {
    name: "worker",
    entry: fileURLToPath(new URL("./worker.mjs", import.meta.url)),
    dbPoolMax: 2,
  },
];

const children = new Map<ServiceSpec["name"], ChildProcess>();
const restartTimers = new Map<ServiceSpec["name"], NodeJS.Timeout>();
const restartCounts = new Map<ServiceSpec["name"], number>();
let stopping = false;
let shutdownTimer: NodeJS.Timeout | undefined;

function startService(service: ServiceSpec): void {
  if (stopping) return;

  const child = spawn(
    process.execPath,
    ["--enable-source-maps", service.entry],
    {
      env: {
        ...process.env,
        DB_APPLICATION_NAME: `lucia-v2-${service.name}`,
        DB_POOL_MAX: String(service.dbPoolMax),
      },
      stdio: "inherit",
    },
  );
  children.set(service.name, child);
  const startedAt = Date.now();
  logger.info(
    { service: service.name, dbPoolMax: service.dbPoolMax },
    "Supervised process started",
  );

  child.once("error", (error) => {
    const errorCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "spawn_failed";
    logger.error(
      { service: service.name, errorCode },
      "Supervised process could not start",
    );
  });

  child.once("close", (code, signal) => {
    const uptimeMs = Date.now() - startedAt;
    if (children.get(service.name) === child) {
      children.delete(service.name);
    }
    if (stopping) {
      if (children.size === 0) {
        if (shutdownTimer) clearTimeout(shutdownTimer);
        process.exit(0);
      }
      return;
    }

    if (uptimeMs >= 60_000) restartCounts.set(service.name, 0);
    const attempts = (restartCounts.get(service.name) ?? 0) + 1;
    restartCounts.set(service.name, attempts);
    const delayMs = Math.min(1_000 * 2 ** Math.min(attempts - 1, 5), 30_000);
    logger.warn(
      { service: service.name, code, signal, uptimeMs, attempts, restartDelayMs: delayMs },
      "Supervised process exited; scheduling restart",
    );

    const timer = setTimeout(() => {
      restartTimers.delete(service.name);
      startService(service);
    }, delayMs);
    restartTimers.set(service.name, timer);
  });
}

function stop(signal: string): void {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "Process supervisor shutting down");

  for (const timer of restartTimers.values()) clearTimeout(timer);
  restartTimers.clear();

  shutdownTimer = setTimeout(() => {
    logger.error({ signal }, "Supervised shutdown timed out");
    for (const child of children.values()) child.kill("SIGKILL");
    process.exit(1);
  }, 12_000);
  shutdownTimer.unref();

  for (const child of children.values()) child.kill("SIGTERM");
  if (children.size === 0) {
    if (shutdownTimer) clearTimeout(shutdownTimer);
    process.exit(0);
  }
}

process.once("SIGTERM", () => stop("SIGTERM"));
process.once("SIGINT", () => stop("SIGINT"));

logger.info(
  {
    apiPoolMax: services.find((service) => service.name === "api")?.dbPoolMax,
    workerPoolMax: services.find((service) => service.name === "worker")?.dbPoolMax,
  },
  "Starting supervised API and worker",
);
for (const service of services) startService(service);
