import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { attachDbPoolMetrics } from "../dist/lib/db-pool-metrics.mjs";

const evidenceDocument = readFileSync(
  new URL("../../../docs/v2-reserved-vm-pilot-evidence.md", import.meta.url),
  "utf8",
);
const planningCeilingMatch = evidenceDocument.match(
  /80% planning\s+ceiling of (\d+)/,
);
assert.ok(
  planningCeilingMatch,
  "documented production 80% planning ceiling is present",
);
const documentedPlanningCeiling = Number(planningCeilingMatch[1]);
assert.equal(documentedPlanningCeiling, 356);

class FakePool extends EventEmitter {
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
}

function reconstructPeak(observations) {
  const activeInstances = new Map();
  let peak = 0;

  for (const { fields } of observations) {
    assert.equal(fields.metric, "v2_db_pool");
    assert.ok(["api", "worker"].includes(fields.service));
    assert.ok(
      ["startup", "connect", "remove", "shutdown"].includes(fields.event),
    );

    if (fields.event === "shutdown") {
      activeInstances.delete(fields.instanceId);
    } else {
      activeInstances.set(fields.instanceId, {
        service: fields.service,
        connectionsOpen: fields.connectionsOpen,
      });
    }

    const totalConnectionsOpen = [...activeInstances.values()].reduce(
      (total, instance) => total + instance.connectionsOpen,
      0,
    );
    peak = Math.max(peak, totalConnectionsOpen);
  }

  return peak;
}

test("pool metrics track physical connection peaks without logging credentials", () => {
  const pool = new FakePool();
  const observations = [];
  const now = () => new Date("2026-11-11T03:00:00.000Z");
  const metrics = attachDbPoolMetrics({
    pool,
    service: "api",
    configuredPoolMax: 4,
    logger: {
      info(fields, message) {
        observations.push({ fields, message });
      },
    },
    instanceId: "test-instance",
    now,
  });

  pool.totalCount = 1;
  pool.emit("connect");
  pool.totalCount = 2;
  pool.emit("connect");
  pool.totalCount = 1;
  pool.emit("remove");
  metrics.observeShutdown();

  assert.deepEqual(
    observations.map(({ fields }) => fields.connectionsOpen),
    [0, 1, 2, 1, 1],
  );
  assert.deepEqual(
    observations.map(({ fields }) => fields.peakConnectionsOpen),
    [0, 1, 2, 2, 2],
  );
  assert.ok(observations.every(({ fields }) => fields.metric === "v2_db_pool"));
  assert.ok(
    observations.every(
      ({ fields }) => fields.observedAt === "2026-11-11T03:00:00.000Z",
    ),
  );
  assert.ok(
    observations.every(
      ({ fields }) =>
        fields.instanceId === "test-instance" &&
        fields.service === "api" &&
        fields.configuredPoolMax === 4,
    ),
  );
  assert.ok(
    observations.every(
      ({ fields }) =>
        !("databaseUrl" in fields) &&
        !("connectionString" in fields) &&
        !("host" in fields),
    ),
  );
  assert.equal(metrics.getPeakConnectionsOpen(), 2);
});

test("reconstructs the overlap peak across ordered API and worker instances", () => {
  const observations = [
    {
      fields: {
        metric: "v2_db_pool",
        observedAt: "2026-11-11T03:00:00.000Z",
        instanceId: "api-old",
        service: "api",
        event: "startup",
        connectionsOpen: 0,
      },
    },
    {
      fields: {
        metric: "v2_db_pool",
        observedAt: "2026-11-11T03:00:00.000Z",
        instanceId: "worker-old",
        service: "worker",
        event: "startup",
        connectionsOpen: 0,
      },
    },
    {
      fields: {
        metric: "v2_db_pool",
        observedAt: "2026-11-11T03:00:01.000Z",
        instanceId: "api-old",
        service: "api",
        event: "connect",
        connectionsOpen: 4,
      },
    },
    {
      fields: {
        metric: "v2_db_pool",
        observedAt: "2026-11-11T03:00:01.000Z",
        instanceId: "worker-old",
        service: "worker",
        event: "connect",
        connectionsOpen: 2,
      },
    },
    {
      fields: {
        metric: "v2_db_pool",
        observedAt: "2026-11-11T03:00:02.000Z",
        instanceId: "api-new",
        service: "api",
        event: "startup",
        connectionsOpen: 0,
      },
    },
    {
      fields: {
        metric: "v2_db_pool",
        observedAt: "2026-11-11T03:00:02.000Z",
        instanceId: "worker-new",
        service: "worker",
        event: "startup",
        connectionsOpen: 0,
      },
    },
    {
      fields: {
        metric: "v2_db_pool",
        observedAt: "2026-11-11T03:00:03.000Z",
        instanceId: "api-new",
        service: "api",
        event: "connect",
        connectionsOpen: 4,
      },
    },
    {
      fields: {
        metric: "v2_db_pool",
        observedAt: "2026-11-11T03:00:03.000Z",
        instanceId: "worker-new",
        service: "worker",
        event: "connect",
        connectionsOpen: 2,
      },
    },
    {
      fields: {
        metric: "v2_db_pool",
        observedAt: "2026-11-11T03:00:03.000Z",
        instanceId: "api-old",
        service: "api",
        event: "remove",
        connectionsOpen: 3,
      },
    },
    {
      fields: {
        metric: "v2_db_pool",
        observedAt: "2026-11-11T03:00:03.000Z",
        instanceId: "worker-old",
        service: "worker",
        event: "remove",
        connectionsOpen: 1,
      },
    },
    {
      fields: {
        metric: "v2_db_pool",
        observedAt: "2026-11-11T03:00:04.000Z",
        instanceId: "api-old",
        service: "api",
        event: "shutdown",
        connectionsOpen: 3,
      },
    },
    {
      fields: {
        metric: "v2_db_pool",
        observedAt: "2026-11-11T03:00:04.000Z",
        instanceId: "worker-old",
        service: "worker",
        event: "shutdown",
        connectionsOpen: 1,
      },
    },
    {
      fields: {
        metric: "v2_db_pool",
        observedAt: "2026-11-11T03:00:05.000Z",
        instanceId: "api-new",
        service: "api",
        event: "remove",
        connectionsOpen: 3,
      },
    },
    {
      fields: {
        metric: "v2_db_pool",
        observedAt: "2026-11-11T03:00:05.000Z",
        instanceId: "worker-new",
        service: "worker",
        event: "remove",
        connectionsOpen: 1,
      },
    },
    {
      fields: {
        metric: "v2_db_pool",
        observedAt: "2026-11-11T03:00:06.000Z",
        instanceId: "api-new",
        service: "api",
        event: "shutdown",
        connectionsOpen: 3,
      },
    },
    {
      fields: {
        metric: "v2_db_pool",
        observedAt: "2026-11-11T03:00:06.000Z",
        instanceId: "worker-new",
        service: "worker",
        event: "shutdown",
        connectionsOpen: 1,
      },
    },
  ];

  const reconstructedPeak = reconstructPeak(observations);

  assert.equal(reconstructedPeak, 12);
  assert.ok(reconstructedPeak < documentedPlanningCeiling);
});
