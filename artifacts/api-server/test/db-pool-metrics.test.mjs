import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { attachDbPoolMetrics } from "../dist/lib/db-pool-metrics.mjs";

class FakePool extends EventEmitter {
  totalCount = 0;
  idleCount = 0;
  waitingCount = 0;
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
