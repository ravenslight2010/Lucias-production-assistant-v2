import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { fileURLToPath } from "node:url";
import { logger as defaultLogger } from "./lib/logger";

export type ServiceSpec = {
  name: "api" | "worker";
  entry: string;
  dbPoolMax: number;
};

export const supervisedServices: ServiceSpec[] = [
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

type Timer = ReturnType<typeof setTimeout>;

type SupervisorDependencies = {
  spawnProcess: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
  logger: typeof defaultLogger;
  exit: (code: number) => void;
  setTimer: (callback: () => void, delayMs: number) => Timer;
  clearTimer: (timer: Timer) => void;
  now: () => number;
};

const defaultDependencies: SupervisorDependencies = {
  spawnProcess: spawn,
  logger: defaultLogger,
  exit: (code) => process.exit(code),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (timer) => clearTimeout(timer),
  now: () => Date.now(),
};

export function createSupervisor(
  dependencies: Partial<SupervisorDependencies> = {},
) {
  const {
    spawnProcess,
    logger,
    exit,
    setTimer,
    clearTimer,
    now,
  } = { ...defaultDependencies, ...dependencies };

  const children = new Map<ServiceSpec["name"], ChildProcess>();
  const restartTimers = new Map<ServiceSpec["name"], Timer>();
  const restartCounts = new Map<ServiceSpec["name"], number>();
  let stopping = false;
  let shutdownTimer: Timer | undefined;
  let shutdownExitCode: number | undefined;

  function finishShutdown(code: number, beforeExit?: () => void): void {
    if (shutdownExitCode !== undefined) return;
    shutdownExitCode = code;
    if (shutdownTimer) clearTimer(shutdownTimer);
    beforeExit?.();
    exit(code);
  }

  function startService(service: ServiceSpec): void {
    if (
      stopping ||
      children.has(service.name) ||
      restartTimers.has(service.name)
    ) {
      return;
    }

    const child = spawnProcess(
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
    const startedAt = now();
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
      const uptimeMs = now() - startedAt;
      if (children.get(service.name) === child) {
        children.delete(service.name);
      }
      if (stopping) {
        if (children.size === 0) {
          finishShutdown(0);
        }
        return;
      }

      if (uptimeMs >= 60_000) restartCounts.set(service.name, 0);
      const attempts = (restartCounts.get(service.name) ?? 0) + 1;
      restartCounts.set(service.name, attempts);
      const delayMs = Math.min(
        1_000 * 2 ** Math.min(attempts - 1, 5),
        30_000,
      );
      logger.warn(
        {
          service: service.name,
          code,
          signal,
          uptimeMs,
          attempts,
          restartDelayMs: delayMs,
        },
        "Supervised process exited; scheduling restart",
      );

      const timer = setTimer(() => {
        restartTimers.delete(service.name);
        startService(service);
      }, delayMs);
      restartTimers.set(service.name, timer);
    });
  }

  function start(): void {
    for (const service of supervisedServices) startService(service);
  }

  function stop(signal: string): void {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "Process supervisor shutting down");

    for (const timer of restartTimers.values()) clearTimer(timer);
    restartTimers.clear();

    shutdownTimer = setTimer(() => {
      finishShutdown(1, () => {
        logger.error({ signal }, "Supervised shutdown timed out");
        for (const child of children.values()) child.kill("SIGKILL");
      });
    }, 12_000);
    shutdownTimer.unref?.();

    for (const child of children.values()) child.kill("SIGTERM");
    if (children.size === 0) {
      finishShutdown(0);
    }
  }

  return { start, stop };
}
