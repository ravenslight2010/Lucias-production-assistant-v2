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
  let workerAvailability: "starting" | "available" | "restarting" = "starting";
  let stopping = false;
  let shutdownTimer: Timer | undefined;
  let shutdownExitCode: number | undefined;
  let shutdownFailed = false;

  function publishWorkerAvailability(): void {
    const api = children.get("api");
    if (api?.connected) {
      api.send({ type: "worker-availability", status: workerAvailability });
    }
  }

  function setWorkerAvailability(
    status: "starting" | "available" | "restarting",
  ): void {
    if (workerAvailability === status) return;
    workerAvailability = status;
    publishWorkerAvailability();
  }

  function finishShutdown(code: number, beforeExit?: () => void): void {
    if (shutdownExitCode !== undefined) return;
    shutdownExitCode = code;
    if (shutdownTimer) clearTimer(shutdownTimer);
    beforeExit?.();
    exit(code);
  }

  function scheduleRestart(
    service: ServiceSpec,
    code: number | null,
    signal: NodeJS.Signals | null,
    uptimeMs: number,
    reason: "exit" | "launch failure",
  ): void {
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
      reason === "exit"
        ? "Supervised process exited; scheduling restart"
        : "Supervised process launch failed; scheduling restart",
    );

    const timer = setTimer(() => {
      restartTimers.delete(service.name);
      startService(service);
    }, delayMs);
    restartTimers.set(service.name, timer);
  }

  function startService(service: ServiceSpec): void {
    if (
      stopping ||
      children.has(service.name) ||
      restartTimers.has(service.name)
    ) {
      return;
    }

    let child: ChildProcess;
    try {
      child = spawnProcess(
        process.execPath,
        ["--enable-source-maps", service.entry],
        {
          env: {
            ...process.env,
            DB_APPLICATION_NAME: `lucia-v2-${service.name}`,
            DB_POOL_MAX: String(service.dbPoolMax),
          },
          stdio:
            service.name === "api"
              ? ["inherit", "inherit", "inherit", "ipc"]
              : "inherit",
        },
      );
    } catch (error) {
      if (service.name === "worker") {
        setWorkerAvailability("restarting");
      }
      const errorCode =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "spawn_failed";
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        { service: service.name, errorCode, errorMessage },
        "Supervised process could not start",
      );
      scheduleRestart(service, null, null, 0, "launch failure");
      return;
    }
    children.set(service.name, child);
    if (service.name === "api") {
      publishWorkerAvailability();
    } else {
      setWorkerAvailability("available");
    }
    const startedAt = now();
    logger.info(
      { service: service.name, dbPoolMax: service.dbPoolMax },
      "Supervised process started",
    );

    child.once("error", (error) => {
      if (service.name === "worker") {
        setWorkerAvailability("restarting");
      }
      const errorCode =
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "spawn_failed";
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        { service: service.name, errorCode, errorMessage },
        "Supervised process could not start",
      );
    });

    child.once("close", (code, signal) => {
      const uptimeMs = now() - startedAt;
      if (children.get(service.name) === child) {
        children.delete(service.name);
      }
      if (stopping) {
        // A clean exit or the SIGTERM requested by stop() is expected.
        // Any other close status makes the overall shutdown fail.
        if (code !== 0 && !(code === null && signal === "SIGTERM")) {
          shutdownFailed = true;
          logger.error(
            { service: service.name, code, signal },
            "Supervised process exited unexpectedly during shutdown",
          );
        }
        if (children.size === 0) {
          finishShutdown(shutdownFailed ? 1 : 0);
        }
        return;
      }

      if (service.name === "worker") {
        setWorkerAvailability("restarting");
      }

      if (uptimeMs >= 60_000) restartCounts.set(service.name, 0);
      scheduleRestart(service, code, signal, uptimeMs, "exit");
    });
  }

  function start(): void {
    if (stopping) return;
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
        logger.error(
          { signal, services: [...children.keys()] },
          "Supervised shutdown timed out",
        );
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
