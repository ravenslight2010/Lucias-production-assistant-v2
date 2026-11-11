import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

type PoolMetricsSource = {
  on: (event: "connect" | "remove", listener: () => void) => unknown;
  totalCount: number;
  idleCount: number;
  waitingCount: number;
};

type PoolMetricsOptions = {
  pool: PoolMetricsSource;
  service: "api" | "worker";
  configuredPoolMax: number;
  logger: Pick<Logger, "info">;
  instanceId?: string;
  now?: () => Date;
};

export function attachDbPoolMetrics({
  pool,
  service,
  configuredPoolMax,
  logger,
  instanceId = randomUUID(),
  now = () => new Date(),
}: PoolMetricsOptions) {
  let peakConnectionsOpen = 0;
  let eventSequence = 0;

  function observe(event: "startup" | "connect" | "remove" | "shutdown") {
    const connectionsOpen = pool.totalCount;
    peakConnectionsOpen = Math.max(peakConnectionsOpen, connectionsOpen);
    eventSequence += 1;
    logger.info(
      {
        metric: "v2_db_pool",
        observedAt: now().toISOString(),
        instanceId,
        eventSequence,
        service,
        event,
        connectionsOpen,
        idleConnections: pool.idleCount,
        waitingRequests: pool.waitingCount,
        peakConnectionsOpen,
        configuredPoolMax,
      },
      "V2 database pool connection observation",
    );
  }

  pool.on("connect", () => observe("connect"));
  pool.on("remove", () => observe("remove"));
  observe("startup");

  return {
    observeShutdown: () => observe("shutdown"),
    getPeakConnectionsOpen: () => peakConnectionsOpen,
  };
}

/**
 * A shutdown observation is terminal for peak reconstruction, so emit it only
 * after the pool confirms it has closed. If end() rejects, callers must leave
 * the instance unclosed in the event stream rather than imply a clean exit.
 */
export async function closeDbPoolAndObserveShutdown(
  pool: { end: () => Promise<void> },
  metrics: { observeShutdown: () => void },
): Promise<void> {
  await pool.end();
  metrics.observeShutdown();
}
