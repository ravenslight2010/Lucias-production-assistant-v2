import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  attachDbPoolMetrics,
  closeDbPoolAndObserveShutdown,
} from "../dist/lib/db-pool-metrics.mjs";

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

function analyzeCapture(observations) {
  const instances = new Map();
  const activeInstances = new Map();
  const issues = [];
  let observedPeakConnectionsOpen = 0;

  if (observations.length === 0) {
    issues.push({ code: "empty_capture" });
  }

  for (const [index, { fields }] of observations.entries()) {
    assert.equal(fields.metric, "v2_db_pool");
    assert.ok(["api", "worker"].includes(fields.service));
    assert.ok(
      ["startup", "connect", "remove", "shutdown"].includes(fields.event),
    );

    let instance = instances.get(fields.instanceId);
    if (!instance) {
      instance = {
        service: fields.service,
        started: false,
        shutdown: false,
        connectionsOpen: null,
      };
      instances.set(fields.instanceId, instance);

      if (fields.event !== "startup") {
        issues.push({
          code: "missing_startup",
          instanceId: fields.instanceId,
          eventIndex: index,
        });
      }
    }

    if (instance.service !== fields.service) {
      issues.push({
        code: "service_changed",
        instanceId: fields.instanceId,
        eventIndex: index,
      });
    }

    if (instance.shutdown) {
      issues.push({
        code: "event_after_shutdown",
        instanceId: fields.instanceId,
        eventIndex: index,
      });
    }

    if (fields.event === "startup") {
      if (instance.started) {
        issues.push({
          code: "duplicate_startup",
          instanceId: fields.instanceId,
          eventIndex: index,
        });
      }
      instance.started = true;
      if (fields.connectionsOpen !== 0) {
        issues.push({
          code: "startup_with_open_connections",
          instanceId: fields.instanceId,
          eventIndex: index,
        });
      }
    } else if (
      fields.event === "connect" &&
      instance.connectionsOpen !== null
    ) {
      if (fields.connectionsOpen !== instance.connectionsOpen + 1) {
        issues.push({
          code: "connect_count_mismatch",
          instanceId: fields.instanceId,
          eventIndex: index,
        });
      }
    } else if (fields.event === "remove" && instance.connectionsOpen !== null) {
      if (fields.connectionsOpen !== instance.connectionsOpen - 1) {
        issues.push({
          code: "remove_count_mismatch",
          instanceId: fields.instanceId,
          eventIndex: index,
        });
      }
    } else if (
      fields.event === "shutdown" &&
      instance.connectionsOpen !== null &&
      instance.connectionsOpen !== 0
    ) {
      issues.push({
        code: "shutdown_with_open_connections",
        instanceId: fields.instanceId,
        eventIndex: index,
      });
    }

    instance.connectionsOpen = fields.connectionsOpen;
    instance.shutdown = fields.event === "shutdown";
    if (instance.shutdown) activeInstances.delete(fields.instanceId);
    else {
      activeInstances.set(fields.instanceId, {
        service: fields.service,
        connectionsOpen: fields.connectionsOpen,
      });
    }

    const totalConnectionsOpen = [...activeInstances.values()].reduce(
      (total, instance) => total + instance.connectionsOpen,
      0,
    );
    observedPeakConnectionsOpen = Math.max(
      observedPeakConnectionsOpen,
      totalConnectionsOpen,
    );
  }

  for (const [instanceId, instance] of instances) {
    if (!instance.shutdown) {
      issues.push({ code: "missing_shutdown", instanceId });
    }
  }

  return {
    complete: issues.length === 0,
    observedPeakConnectionsOpen,
    issues,
  };
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

test("API and worker record terminal pool observations only after pool close succeeds", async (t) => {
  for (const service of ["api", "worker"]) {
    await t.test(
      `${service} records a final shutdown observation`,
      async () => {
        const pool = new FakePool();
        const observations = [];
        let poolClosed = false;
        pool.totalCount = 2;
        pool.idleCount = 1;
        pool.end = async () => {
          poolClosed = true;
          pool.totalCount = 0;
          pool.idleCount = 0;
        };
        const metrics = attachDbPoolMetrics({
          pool,
          service,
          configuredPoolMax: 4,
          logger: {
            info(fields) {
              observations.push({ fields, poolClosed });
            },
          },
          instanceId: `${service}-shutdown-test`,
        });

        await closeDbPoolAndObserveShutdown(pool, metrics);

        const finalObservation = observations.at(-1);
        assert.ok(finalObservation);
        assert.equal(finalObservation.poolClosed, true);
        assert.deepEqual(
          {
            metric: finalObservation.fields.metric,
            service: finalObservation.fields.service,
            event: finalObservation.fields.event,
            connectionsOpen: finalObservation.fields.connectionsOpen,
          },
          {
            metric: "v2_db_pool",
            service,
            event: "shutdown",
            connectionsOpen: 0,
          },
        );
      },
    );

    await t.test(
      `${service} omits shutdown when pool close fails`,
      async () => {
        const pool = new FakePool();
        const observations = [];
        pool.end = async () => {
          throw new Error("pool close failed");
        };
        const metrics = attachDbPoolMetrics({
          pool,
          service,
          configuredPoolMax: 4,
          logger: { info: (fields) => observations.push(fields) },
          instanceId: `${service}-failed-shutdown-test`,
        });

        await assert.rejects(
          closeDbPoolAndObserveShutdown(pool, metrics),
          /pool close failed/,
        );
        assert.equal(
          observations.some(({ event }) => event === "shutdown"),
          false,
        );
      },
    );
  }
});

function addObservation(
  observations,
  instanceId,
  service,
  event,
  connectionsOpen,
  second,
) {
  observations.push({
    fields: {
      metric: "v2_db_pool",
      observedAt: `2026-11-11T03:00:${String(second).padStart(2, "0")}.000Z`,
      instanceId,
      service,
      event,
      connectionsOpen,
    },
  });
}

function addLifecycle(
  observations,
  instanceId,
  service,
  startSecond,
  connectionCount,
) {
  addObservation(observations, instanceId, service, "startup", 0, startSecond);
  for (let count = 1; count <= connectionCount; count++) {
    addObservation(
      observations,
      instanceId,
      service,
      "connect",
      count,
      startSecond + 1,
    );
  }
}

test("reconstructs the overlap peak across ordered API and worker instances", () => {
  const observations = [];
  addLifecycle(observations, "api-old", "api", 0, 4);
  addLifecycle(observations, "worker-old", "worker", 0, 2);
  addLifecycle(observations, "api-new", "api", 2, 4);
  addLifecycle(observations, "worker-new", "worker", 2, 2);

  for (const [instanceId, service, count] of [
    ["api-old", "api", 4],
    ["worker-old", "worker", 2],
    ["api-new", "api", 4],
    ["worker-new", "worker", 2],
  ]) {
    for (let remaining = count - 1; remaining >= 0; remaining--) {
      addObservation(observations, instanceId, service, "remove", remaining, 4);
    }
  }
  addObservation(observations, "api-old", "api", "shutdown", 0, 5);
  addObservation(observations, "worker-old", "worker", "shutdown", 0, 5);
  addObservation(observations, "api-new", "api", "shutdown", 0, 6);
  addObservation(observations, "worker-new", "worker", "shutdown", 0, 6);

  const capture = analyzeCapture(observations);

  assert.equal(capture.complete, true);
  assert.deepEqual(capture.issues, []);
  assert.equal(capture.observedPeakConnectionsOpen, 12);
  assert.ok(capture.observedPeakConnectionsOpen < documentedPlanningCeiling);
});

test("flags partial captures with missing lifecycle and connection records", () => {
  const observations = [];
  addObservation(observations, "api-partial", "api", "connect", 3, 1);
  addObservation(observations, "api-partial", "api", "remove", 1, 2);
  addObservation(observations, "worker-partial", "worker", "startup", 0, 1);
  addObservation(observations, "worker-partial", "worker", "connect", 1, 2);
  addObservation(observations, "worker-partial", "worker", "shutdown", 1, 3);
  addObservation(observations, "api-gap", "api", "startup", 0, 1);
  addObservation(observations, "api-gap", "api", "connect", 3, 2);
  addObservation(observations, "api-gap", "api", "remove", 2, 3);
  addObservation(observations, "api-gap", "api", "remove", 1, 4);
  addObservation(observations, "api-gap", "api", "remove", 0, 5);
  addObservation(observations, "api-gap", "api", "shutdown", 0, 6);

  const capture = analyzeCapture(observations);

  assert.equal(capture.complete, false);
  assert.deepEqual(
    new Set(capture.issues.map(({ code }) => code)),
    new Set([
      "missing_startup",
      "connect_count_mismatch",
      "remove_count_mismatch",
      "missing_shutdown",
      "shutdown_with_open_connections",
    ]),
  );
  assert.ok(capture.observedPeakConnectionsOpen >= 3);
  assert.equal("measuredPeakConnectionsOpen" in capture, false);
});

test("does not treat an empty capture as complete", () => {
  const capture = analyzeCapture([]);

  assert.equal(capture.complete, false);
  assert.deepEqual(capture.issues, [{ code: "empty_capture" }]);
});
