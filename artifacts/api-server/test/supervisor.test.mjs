import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  createSupervisor,
  supervisedServices,
} from "../dist/supervisor-runtime.mjs";

const quietLogger = {
  info() {},
  warn() {},
  error() {},
};

function createHarness() {
  const children = [];
  const timers = [];
  const exits = [];
  const supervisor = createSupervisor({
    spawnProcess(_command, args, options) {
      const child = new EventEmitter();
      const emit = child.emit.bind(child);
      child.emit = (event, ...args) => {
        if (event === "close") child.closed = true;
        return emit(event, ...args);
      };
      child.closed = false;
      child.args = args;
      child.options = options;
      child.signals = [];
      child.kill = (signal) => {
        child.signals.push(signal);
        return true;
      };
      children.push(child);
      return child;
    },
    logger: quietLogger,
    exit: (code) => exits.push(code),
    setTimer(callback, delayMs) {
      const timer = {
        callback,
        delayMs,
        cleared: false,
        unref() {},
      };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
    },
    now: () => 100,
  });

  return { supervisor, children, timers, exits };
}

test("worker termination restarts one worker without duplicating the API", () => {
  const { supervisor, children, timers } = createHarness();
  supervisor.start();

  const [api, worker] = children;
  assert.equal(children.length, 2);

  worker.emit("close", 1, "SIGKILL");
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 1_000);
  assert.equal(children.length, 2);

  timers[0].callback();
  assert.equal(children.length, 3);
  assert.equal(children[2].options.env.DB_APPLICATION_NAME, "lucia-v2-worker");
  assert.equal(children[2].options.env.DB_POOL_MAX, "2");

  const activeApi = children.filter((child) => child === api);
  const activeWorkers = children.filter(
    (child) => child.options.env.DB_APPLICATION_NAME === "lucia-v2-worker",
  );
  assert.equal(activeApi.length, 1);
  assert.equal(activeWorkers.length, 2);
  assert.equal(activeWorkers.filter((child) => !child.closed).length, 1);

  const restartedWorker = children[2];
  supervisor.stop("SIGTERM");
  assert.deepEqual(api.signals, ["SIGTERM"]);
  assert.deepEqual(restartedWorker.signals, ["SIGTERM"]);
  restartedWorker.emit("close", 0, "SIGTERM");
  api.emit("close", 0, "SIGTERM");
  assert.equal(children.length, 3);
});

test("graceful shutdown signals both children and prevents a replacement worker", () => {
  const { supervisor, children, timers, exits } = createHarness();
  supervisor.start();

  const [api, worker] = children;
  supervisor.stop("SIGTERM");

  assert.deepEqual(api.signals, ["SIGTERM"]);
  assert.deepEqual(worker.signals, ["SIGTERM"]);

  worker.emit("close", 0, "SIGTERM");
  api.emit("close", 0, "SIGTERM");

  assert.deepEqual(exits, [0]);
  assert.equal(timers.some((timer) => timer.delayMs === 1_000 && !timer.cleared), false);
  assert.equal(children.length, 2);
});

test("shutdown force-kills children that remain open after the timeout", () => {
  const { supervisor, children, timers, exits } = createHarness();
  supervisor.start();

  const [api, worker] = children;
  supervisor.stop("SIGTERM");

  assert.deepEqual(api.signals, ["SIGTERM"]);
  assert.deepEqual(worker.signals, ["SIGTERM"]);
  assert.equal(api.closed, false);
  assert.equal(worker.closed, false);

  const shutdownTimer = timers.find((timer) => timer.delayMs === 12_000);
  assert.ok(shutdownTimer);
  assert.equal(shutdownTimer.cleared, false);

  shutdownTimer.callback();

  assert.deepEqual(api.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(worker.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(exits, [1]);
});

test("pool maxima match the documented connection budget", async () => {
  const evidence = await readFile(
    new URL("../../../docs/v2-reserved-vm-pilot-evidence.md", import.meta.url),
    "utf8",
  );
  const poolFor = (name) => {
    const service = supervisedServices.find((entry) => entry.name === name);
    assert.ok(service, `missing ${name} service configuration`);
    return service.dbPoolMax;
  };
  const apiMax = poolFor("api");
  const workerMax = poolFor("worker");
  const configuredTotal = apiMax + workerMax;
  const numberFromEvidence = (label) => {
    const match = evidence.match(new RegExp(`\\| ${label} \\| (\\d+) \\|`));
    assert.ok(match, `missing ${label} in pilot evidence`);
    return Number(match[1]);
  };
  const databaseMax = numberFromEvidence("Database `max_connections`");
  const reserved = numberFromEvidence("Reserved PostgreSQL connections");
  const planningCeiling = numberFromEvidence("80% planning ceiling");

  assert.match(evidence, new RegExp(`API database pool maximum: ${apiMax} connections`));
  assert.match(
    evidence,
    new RegExp(`Worker database pool maximum: ${workerMax} connections`),
  );
  assert.equal(
    numberFromEvidence("Steady-state configured pool total"),
    configuredTotal,
  );
  assert.ok(configuredTotal <= databaseMax - reserved);
  assert.ok(configuredTotal <= planningCeiling);
  assert.ok(numberFromEvidence("Planned overlap plus reserve") <= planningCeiling);
});
