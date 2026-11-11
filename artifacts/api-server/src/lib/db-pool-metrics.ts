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

  function observe(event: "startup" | "connect" | "remove" | "shutdown") {
    const connectionsOpen = pool.totalCount;
    peakConnectionsOpen = Math.max(peakConnectionsOpen, connectionsOpen);
    logger.info(
      {
        metric: "v2_db_pool",
        observedAt: now().toISOString(),
        instanceId,
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
