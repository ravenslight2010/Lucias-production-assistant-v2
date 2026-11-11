import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  createSupervisor,
  supervisedServices,
} from "../dist/supervisor-runtime.mjs";

function createHarness({ launcher } = {}) {
  const children = [];
  const timers = [];
  const exits = [];
  let currentTime = 100;
  const logs = { info: [], warn: [], error: [] };
  const logger = Object.fromEntries(
    Object.entries(logs).map(([level, entries]) => [
      level,
      (...args) => entries.push(args),
    ]),
  );
  const defaultLauncher = (_command, args, options) => {
    const child = new EventEmitter();
    const emit = child.emit.bind(child);
    child.emit = (event, ...args) => {
      if (event === "close") child.closed = true;
      return emit(event, ...args);
    };
    child.closed = false;
    child.connected = true;
    child.args = args;
    child.options = options;
    child.signals = [];
    child.messages = [];
    child.send = (message) => child.messages.push(message);
    child.kill = (signal) => {
      child.signals.push(signal);
      return true;
    };
    children.push(child);
    return child;
  };
  const supervisor = createSupervisor({
    spawnProcess(command, args, options) {
      return launcher
        ? launcher(command, args, options, defaultLauncher)
        : defaultLauncher(command, args, options);
    },
    logger,
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
    now: () => currentTime,
  });

  return {
    supervisor,
    children,
    timers,
    exits,
    logs,
    setNow(value) {
      currentTime = value;
    },
  };
}

test("repeated startup does not duplicate active or scheduled services", () => {
  const { supervisor, children, timers } = createHarness();
  supervisor.start();
  supervisor.start();

  assert.equal(children.length, 2);
  const [api, worker] = children;

  worker.emit("close", 1, "SIGKILL");
  supervisor.start();
  assert.equal(children.length, 2);
  assert.equal(timers.length, 1);

  timers[0].callback();
  assert.equal(children.length, 3);
  assert.equal(
    children.filter(
      (child) =>
        child.options.env.DB_APPLICATION_NAME === "lucia-v2-api" &&
        !child.closed,
    ).length,
    1,
  );
  assert.equal(
    children.filter(
      (child) =>
        child.options.env.DB_APPLICATION_NAME === "lucia-v2-worker" &&
        !child.closed,
    ).length,
    1,
  );
  assert.equal(api.closed, false);
});

test("API child receives its configured database identity and pool maximum", () => {
  const { supervisor, children } = createHarness();
  const apiService = supervisedServices.find((service) => service.name === "api");
  assert.ok(apiService, "missing api service configuration");

  supervisor.start();

  const api = children.find((child) => child.args.includes(apiService.entry));
  assert.ok(api, "missing API child process");
  assert.equal(api.options.env.DB_APPLICATION_NAME, "lucia-v2-api");
  assert.equal(api.options.env.DB_POOL_MAX, String(apiService.dbPoolMax));
});

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

test("worker availability is reported through restart and recovery", () => {
  const { supervisor, children, timers } = createHarness();
  supervisor.start();

  const [api, worker] = children;
  assert.deepEqual(api.options.stdio, ["inherit", "inherit", "inherit", "ipc"]);
  assert.deepEqual(api.messages, [
    { type: "worker-availability", status: "starting" },
    { type: "worker-availability", status: "available" },
  ]);

  worker.emit("close", 1, "SIGKILL");
  assert.deepEqual(api.messages.at(-1), {
    type: "worker-availability",
    status: "restarting",
  });
  assert.equal(timers.at(-1).delayMs, 1_000);

  timers.at(-1).callback();
  assert.deepEqual(api.messages.at(-1), {
    type: "worker-availability",
    status: "available",
  });
  assert.equal(api.messages.length, 4);
  assert.ok(
    api.messages.every(
      (message) =>
        Object.keys(message).sort().join(",") === "status,type" &&
        !("pid" in message) &&
        !("error" in message),
    ),
  );
});

test("clean API exit schedules one API replacement and leaves the worker running", () => {
  const { supervisor, children, timers } = createHarness();
  supervisor.start();

  const [api, worker] = children;
  api.emit("close", 0, null);

  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 1_000);
  supervisor.start();
  assert.equal(children.length, 2);

  timers[0].callback();

  assert.equal(children.length, 3);
  assert.equal(children[2].options.env.DB_APPLICATION_NAME, "lucia-v2-api");
  assert.equal(children.filter((child) => !child.closed).length, 2);
  assert.equal(worker.closed, false);
  assert.equal(
    children.filter(
      (child) =>
        child.options.env.DB_APPLICATION_NAME === "lucia-v2-api" &&
        !child.closed,
    ).length,
    1,
  );
  assert.equal(
    children.filter(
      (child) =>
        child.options.env.DB_APPLICATION_NAME === "lucia-v2-worker" &&
        !child.closed,
    ).length,
    1,
  );
});

test("clean worker exit schedules one worker replacement and leaves the API running", () => {
  const { supervisor, children, timers } = createHarness();
  supervisor.start();

  const [api, worker] = children;
  worker.emit("close", 0, null);

  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 1_000);
  supervisor.start();
  assert.equal(children.length, 2);

  timers[0].callback();

  assert.equal(children.length, 3);
  assert.equal(children[2].options.env.DB_APPLICATION_NAME, "lucia-v2-worker");
  assert.equal(children.filter((child) => !child.closed).length, 2);
  assert.equal(api.closed, false);
  assert.equal(
    children.filter(
      (child) =>
        child.options.env.DB_APPLICATION_NAME === "lucia-v2-api" &&
        !child.closed,
    ).length,
    1,
  );
  assert.equal(
    children.filter(
      (child) =>
        child.options.env.DB_APPLICATION_NAME === "lucia-v2-worker" &&
        !child.closed,
    ).length,
    1,
  );
});

test("worker restart delay increases exponentially and caps at 30 seconds", () => {
  const { supervisor, children, timers } = createHarness();
  supervisor.start();

  let worker = children[1];
  const expectedDelays = [
    1_000,
    2_000,
    4_000,
    8_000,
    16_000,
    30_000,
    30_000,
  ];

  for (const expectedDelay of expectedDelays) {
    worker.emit("close", 1, "SIGKILL");
    const restartTimer = timers.at(-1);
    assert.equal(restartTimer.delayMs, expectedDelay);
    restartTimer.callback();
    worker = children.at(-1);
  }
});

test("API restart delay caps at 30 seconds without affecting worker retries", () => {
  const { supervisor, children, timers } = createHarness();
  supervisor.start();

  let api = children[0];
  const apiRestartDelays = [
    1_000,
    2_000,
    4_000,
    8_000,
    16_000,
    30_000,
    30_000,
  ];
  for (const [index, expectedDelay] of apiRestartDelays.entries()) {
    api.emit("close", 1, "SIGKILL");
    const restartTimer = timers.at(-1);
    assert.equal(restartTimer.delayMs, expectedDelay);
    assert.ok(restartTimer.delayMs <= 30_000);
    if (index < apiRestartDelays.length - 1) {
      restartTimer.callback();
      api = children.at(-1);
    }
  }
  const cappedApiRestartTimer = timers.at(-1);

  const worker = children[1];
  worker.emit("close", 1, "SIGKILL");
  assert.equal(timers.at(-1).delayMs, 1_000);
  timers.at(-1).callback();

  const restartedWorker = children.at(-1);
  restartedWorker.emit("close", 1, "SIGKILL");
  assert.equal(timers.at(-1).delayMs, 2_000);
  assert.equal(cappedApiRestartTimer.delayMs, 30_000);
});

test("clean exits increase each service restart delay independently and cap at 30 seconds", () => {
  const { supervisor, children, timers } = createHarness();
  supervisor.start();

  const expectedDelays = [
    1_000,
    2_000,
    4_000,
    8_000,
    16_000,
    30_000,
    30_000,
  ];
  const apiDelays = [];
  let api = children[0];

  for (const [index, expectedDelay] of expectedDelays.entries()) {
    api.emit("close", 0, null);
    const restartTimer = timers.at(-1);
    assert.equal(restartTimer.delayMs, expectedDelay);
    apiDelays.push(restartTimer.delayMs);
    if (index < expectedDelays.length - 1) {
      restartTimer.callback();
      api = children.at(-1);
    }
  }

  const apiRestartTimer = timers.at(-1);
  const workerDelays = [];
  let worker = children[1];

  for (const [index, expectedDelay] of expectedDelays.entries()) {
    worker.emit("close", 0, null);
    const restartTimer = timers.at(-1);
    assert.equal(restartTimer.delayMs, expectedDelay);
    workerDelays.push(restartTimer.delayMs);
    if (index < expectedDelays.length - 1) {
      restartTimer.callback();
      worker = children.at(-1);
    }
  }

  assert.deepEqual(apiDelays, expectedDelays);
  assert.deepEqual(workerDelays, expectedDelays);
  assert.equal(apiRestartTimer.delayMs, 30_000);
  assert.equal(apiRestartTimer.cleared, false);
});

test("worker stable for 60 seconds resets the restart delay", () => {
  const { supervisor, children, timers, setNow } = createHarness();
  supervisor.start();

  let worker = children[1];
  worker.emit("close", 1, "SIGKILL");
  assert.equal(timers.at(-1).delayMs, 1_000);
  timers.at(-1).callback();

  worker = children.at(-1);
  worker.emit("close", 1, "SIGKILL");
  assert.equal(timers.at(-1).delayMs, 2_000);
  timers.at(-1).callback();

  worker = children.at(-1);
  setNow(60_100);
  worker.emit("close", 1, "SIGKILL");
  assert.equal(timers.at(-1).delayMs, 1_000);
});

test("API stable for 60 seconds resets the restart delay", () => {
  const { supervisor, children, timers, setNow } = createHarness();
  supervisor.start();

  let api = children[0];
  api.emit("close", 1, "SIGKILL");
  assert.equal(timers.at(-1).delayMs, 1_000);
  timers.at(-1).callback();

  api = children.at(-1);
  api.emit("close", 1, "SIGKILL");
  assert.equal(timers.at(-1).delayMs, 2_000);
  timers.at(-1).callback();

  api = children.at(-1);
  setNow(60_100);
  api.emit("close", 1, "SIGKILL");
  assert.equal(timers.at(-1).delayMs, 1_000);
});

test("worker clean exit after 60 seconds resets the restart delay", () => {
  const { supervisor, children, timers, setNow } = createHarness();
  supervisor.start();

  let worker = children[1];
  worker.emit("close", 0, null);
  assert.equal(timers.at(-1).delayMs, 1_000);
  timers.at(-1).callback();

  worker = children.at(-1);
  worker.emit("close", 0, null);
  assert.equal(timers.at(-1).delayMs, 2_000);
  timers.at(-1).callback();

  worker = children.at(-1);
  setNow(60_100);
  worker.emit("close", 0, null);
  assert.equal(timers.at(-1).delayMs, 1_000);
});

test("API clean exit after 60 seconds resets the restart delay", () => {
  const { supervisor, children, timers, setNow } = createHarness();
  supervisor.start();

  let api = children[0];
  api.emit("close", 0, null);
  assert.equal(timers.at(-1).delayMs, 1_000);
  timers.at(-1).callback();

  api = children.at(-1);
  api.emit("close", 0, null);
  assert.equal(timers.at(-1).delayMs, 2_000);
  timers.at(-1).callback();

  api = children.at(-1);
  setNow(60_100);
  api.emit("close", 0, null);
  assert.equal(timers.at(-1).delayMs, 1_000);
});

test("spawn errors are logged and retried after the child closes", () => {
  const { supervisor, children, timers, logs } = createHarness();
  supervisor.start();

  const [api, worker] = children;
  const spawnError = Object.assign(new Error("worker entry not found"), {
    code: "ENOENT",
  });
  worker.emit("error", spawnError);

  assert.equal(logs.error.length, 1);
  assert.deepEqual(logs.error[0], [
    {
      service: "worker",
      errorCode: "ENOENT",
      errorMessage: "worker entry not found",
    },
    "Supervised process could not start",
  ]);
  assert.equal(children.length, 2);
  assert.equal(timers.length, 0);

  worker.emit("close", -2, null);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 1_000);

  timers[0].callback();
  assert.equal(children.length, 3);
  assert.equal(children[2].options.env.DB_APPLICATION_NAME, "lucia-v2-worker");
  assert.equal(children[2].closed, false);

  supervisor.stop("SIGTERM");
  assert.deepEqual(api.signals, ["SIGTERM"]);
  assert.deepEqual(children[2].signals, ["SIGTERM"]);
  assert.deepEqual(worker.signals, []);
});

test("API spawn errors log the operating-system reason without environment data", () => {
  const { supervisor, children, logs } = createHarness();
  supervisor.start();

  const [api] = children;
  api.emit(
    "error",
    Object.assign(new Error("API entry not found"), { code: "ENOENT" }),
  );

  assert.deepEqual(logs.error, [
    [
      {
        service: "api",
        errorCode: "ENOENT",
        errorMessage: "API entry not found",
      },
      "Supervised process could not start",
    ],
  ]);
  assert.deepEqual(Object.keys(logs.error[0][0]).sort(), [
    "errorCode",
    "errorMessage",
    "service",
  ]);
  assert.equal("env" in logs.error[0][0], false);
});

test("successive spawn errors retain only each attempt's diagnostics", () => {
  const { supervisor, children, timers, logs } = createHarness();
  supervisor.start();

  let worker = children[1];
  const failures = [
    { code: "ENOENT", message: "worker entry not found" },
    { code: "EACCES", message: "worker entry is not executable" },
  ];

  for (const [index, failure] of failures.entries()) {
    worker.emit(
      "error",
      Object.assign(new Error(failure.message), { code: failure.code }),
    );
    worker.emit("close", -2, null);

    const retryTimer = timers.at(-1);
    assert.equal(retryTimer.delayMs, 1_000 * 2 ** index);
    retryTimer.callback();
    worker = children.at(-1);
  }

  assert.deepEqual(
    logs.error.map(([fields, message]) => {
      assert.deepEqual(Object.keys(fields).sort(), [
        "errorCode",
        "errorMessage",
        "service",
      ]);
      assert.equal("env" in fields, false);
      return [fields, message];
    }),
    failures.map((failure) => [
      {
        service: "worker",
        errorCode: failure.code,
        errorMessage: failure.message,
      },
      "Supervised process could not start",
    ]),
  );
});

test("API and worker spawn errors without standard details get safe diagnostics", () => {
  for (const [service, childIndex] of [
    ["api", 0],
    ["worker", 1],
  ]) {
    const { supervisor, children, logs } = createHarness();
    supervisor.start();
    children[childIndex].emit("error", {});

    assert.deepEqual(logs.error, [
      [
        {
          service,
          errorCode: "spawn_failed",
          errorMessage: "No additional error details were provided",
        },
        "Supervised process could not start",
      ],
    ]);
    assert.deepEqual(Object.keys(logs.error[0][0]).sort(), [
      "errorCode",
      "errorMessage",
      "service",
    ]);
    assert.equal("env" in logs.error[0][0], false);
  }
});

test("synchronous API and worker launch errors without details get safe diagnostics", () => {
  const { supervisor, logs } = createHarness({
    launcher(_command, _args, _options, defaultLauncher) {
      throw {};
    },
  });
  supervisor.start();

  assert.deepEqual(
    logs.error.map(([details, message]) => [details, message]),
    [
      [
        {
          service: "api",
          errorCode: "spawn_failed",
          errorMessage: "No additional error details were provided",
        },
        "Supervised process could not start",
      ],
      [
        {
          service: "worker",
          errorCode: "spawn_failed",
          errorMessage: "No additional error details were provided",
        },
        "Supervised process could not start",
      ],
    ],
  );
  assert.ok(logs.error.every(([details]) => !("env" in details)));
});

test("startup error messages are capped before logging", () => {
  const { supervisor, children, logs } = createHarness();
  supervisor.start();
  children[0].emit("error", new Error("x".repeat(800)));

  assert.equal(logs.error[0][0].errorMessage.length, 500);
  assert.equal(logs.error[0][0].errorMessage, "x".repeat(500));
});


test("repeated synchronous launcher failures keep each service's backoff isolated", () => {
  const launchAttempts = [];
  let apiLaunches = 0;
  const { supervisor, children, timers } = createHarness({
    launcher(command, args, options, defaultLauncher) {
      const service = options.env.DB_APPLICATION_NAME;
      launchAttempts.push(service);
      if (service === "lucia-v2-api" && apiLaunches++ < 2) {
        throw Object.assign(new Error("process limit reached"), {
          code: "EAGAIN",
        });
      }
      return defaultLauncher(command, args, options);
    },
  });

  supervisor.start();

  assert.deepEqual(launchAttempts, ["lucia-v2-api", "lucia-v2-worker"]);
  assert.equal(children.length, 1);
  assert.equal(children[0].options.env.DB_APPLICATION_NAME, "lucia-v2-worker");
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 1_000);

  const firstWorker = children[0];
  firstWorker.emit("close", 1, "SIGKILL");
  assert.equal(timers.length, 2);
  assert.equal(timers[1].delayMs, 1_000);

  timers[0].callback();
  assert.equal(timers.length, 3);
  assert.equal(timers[2].delayMs, 2_000);
  assert.equal(timers[1].cleared, false);

  timers[1].callback();
  assert.equal(children.length, 2);
  const secondWorker = children[1];
  secondWorker.emit("close", 1, "SIGKILL");
  assert.equal(timers.length, 4);
  assert.equal(timers[3].delayMs, 2_000);

  timers[2].callback();
  assert.deepEqual(launchAttempts, [
    "lucia-v2-api",
    "lucia-v2-worker",
    "lucia-v2-api",
    "lucia-v2-worker",
    "lucia-v2-api",
  ]);
  assert.equal(children.length, 3);
  assert.equal(children[2].options.env.DB_APPLICATION_NAME, "lucia-v2-api");
  assert.equal(children[2].closed, false);
});

test("simultaneous synchronous launcher failures retry independently", () => {
  const launchAttempts = [];
  const launchCounts = new Map();
  const { supervisor, children, timers } = createHarness({
    launcher(command, args, options, defaultLauncher) {
      const service = options.env.DB_APPLICATION_NAME;
      launchAttempts.push(service);
      const launches = launchCounts.get(service) ?? 0;
      launchCounts.set(service, launches + 1);
      if (launches === 0) {
        throw Object.assign(new Error(`${service} launch failed`), {
          code: "EAGAIN",
        });
      }
      return defaultLauncher(command, args, options);
    },
  });

  supervisor.start();

  assert.deepEqual(launchAttempts, ["lucia-v2-api", "lucia-v2-worker"]);
  assert.equal(children.length, 0);
  assert.equal(timers.length, 2);
  const [apiRetry, workerRetry] = timers;
  assert.equal(apiRetry.delayMs, 1_000);
  assert.equal(workerRetry.delayMs, 1_000);

  workerRetry.callback();
  workerRetry.callback();
  assert.deepEqual(launchAttempts, [
    "lucia-v2-api",
    "lucia-v2-worker",
    "lucia-v2-worker",
  ]);
  assert.equal(children.length, 1);
  assert.equal(children[0].options.env.DB_APPLICATION_NAME, "lucia-v2-worker");

  apiRetry.callback();
  apiRetry.callback();
  assert.deepEqual(launchAttempts, [
    "lucia-v2-api",
    "lucia-v2-worker",
    "lucia-v2-worker",
    "lucia-v2-api",
  ]);
  assert.equal(children.length, 2);
  assert.deepEqual(
    children.map((child) => child.options.env.DB_APPLICATION_NAME).sort(),
    ["lucia-v2-api", "lucia-v2-worker"],
  );
  assert.equal(children.every((child) => !child.closed), true);
});

test("API and worker spawn failures retry independently", () => {
  const { supervisor, children, timers } = createHarness();
  supervisor.start();

  const [api, worker] = children;
  api.emit(
    "error",
    Object.assign(new Error("API entry not found"), { code: "ENOENT" }),
  );
  worker.emit(
    "error",
    Object.assign(new Error("worker entry not found"), { code: "ENOENT" }),
  );
  api.emit("close", -2, null);
  worker.emit("close", -2, null);

  assert.equal(timers.length, 2);
  const [apiRetry, workerRetry] = timers;
  assert.equal(apiRetry.delayMs, 1_000);
  assert.equal(workerRetry.delayMs, 1_000);
  assert.equal(children.length, 2);

  apiRetry.callback();
  assert.equal(children.length, 3);
  assert.equal(children[2].options.env.DB_APPLICATION_NAME, "lucia-v2-api");
  assert.equal(workerRetry.cleared, false);
  assert.equal(children[1].closed, true);

  workerRetry.callback();
  assert.equal(children.length, 4);
  assert.equal(children[3].options.env.DB_APPLICATION_NAME, "lucia-v2-worker");
  assert.equal(children[2].closed, false);
  assert.equal(children[3].closed, false);

  supervisor.stop("SIGTERM");
  children[2].emit("close", 0, "SIGTERM");
  children[3].emit("close", 0, "SIGTERM");
});

test("shutdown clears both pending spawn-failure retries", () => {
  const { supervisor, children, timers, exits } = createHarness();
  supervisor.start();

  const [api, worker] = children;
  api.emit(
    "error",
    Object.assign(new Error("API entry not found"), { code: "ENOENT" }),
  );
  worker.emit(
    "error",
    Object.assign(new Error("worker entry not found"), { code: "ENOENT" }),
  );
  api.emit("close", -2, null);
  worker.emit("close", -2, null);

  const retryTimers = timers.filter((timer) => timer.delayMs === 1_000);
  assert.equal(retryTimers.length, 2);
  supervisor.stop("SIGTERM");

  assert.deepEqual(retryTimers.map((timer) => timer.cleared), [true, true]);
  assert.deepEqual(exits, [0]);
  for (const timer of retryTimers) timer.callback();
  assert.equal(children.length, 2);
  assert.deepEqual(exits, [0]);
});

test("shutdown after a spawn error fails when that child closes abnormally", () => {
  const { supervisor, children, timers, exits, logs } = createHarness();
  supervisor.start();

  const [api, worker] = children;
  worker.emit(
    "error",
    Object.assign(new Error("worker entry not found"), { code: "ENOENT" }),
  );
  supervisor.stop("SIGTERM");

  assert.deepEqual(api.signals, ["SIGTERM"]);
  assert.deepEqual(worker.signals, ["SIGTERM"]);
  assert.equal(timers.filter((timer) => timer.delayMs === 1_000).length, 0);

  worker.emit("close", -2, null);
  api.emit("close", 0, "SIGTERM");

  assert.deepEqual(exits, [1]);
  assert.equal(
    timers.some((timer) => timer.delayMs === 12_000 && timer.cleared),
    true,
  );
  assert.equal(timers.some((timer) => timer.delayMs === 1_000), false);
  assert.equal(logs.warn.length, 0);
  assert.equal(children.length, 2);
});

test("shutdown before start exits once without spawning services or leaving a timeout", () => {
  const { supervisor, children, timers, exits } = createHarness();

  supervisor.stop("SIGTERM");
  supervisor.start();
  supervisor.start();
  supervisor.stop("SIGTERM");
  supervisor.start();

  assert.equal(children.length, 0);
  assert.deepEqual(exits, [0]);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delayMs, 12_000);
  assert.equal(timers[0].cleared, true);
  assert.equal(timers.filter((timer) => !timer.cleared).length, 0);
});

test("graceful shutdown signals both children and prevents a replacement worker", () => {
  const { supervisor, children, timers, exits } = createHarness();
  supervisor.start();

  const [api, worker] = children;
  supervisor.stop("SIGTERM");

  assert.deepEqual(api.signals, ["SIGTERM"]);
  assert.deepEqual(worker.signals, ["SIGTERM"]);

  worker.emit("close", null, "SIGTERM");
  api.emit("close", 0, null);

  assert.deepEqual(exits, [0]);
  assert.equal(timers.some((timer) => timer.delayMs === 1_000 && !timer.cleared), false);
  assert.equal(children.length, 2);
});

test("shutdown fails if one child exits abnormally while another exits on SIGTERM", () => {
  const { supervisor, children, exits, logs } = createHarness();
  supervisor.start();

  const [api, worker] = children;
  supervisor.stop("SIGTERM");

  api.emit("close", 1, null);
  assert.deepEqual(exits, []);

  worker.emit("close", null, "SIGTERM");

  assert.deepEqual(exits, [1]);
  assert.deepEqual(logs.error.at(-1), [
    { service: "api", code: 1, signal: null },
    "Supervised process exited unexpectedly during shutdown",
  ]);
});

test("shutdown cancels a pending worker restart and waits for active children", () => {
  const { supervisor, children, timers, exits } = createHarness();
  supervisor.start();

  const [api, worker] = children;
  worker.emit("close", 1, "SIGKILL");
  const restartTimer = timers.find((timer) => timer.delayMs === 1_000);
  assert.ok(restartTimer);

  supervisor.stop("SIGTERM");

  assert.equal(restartTimer.cleared, true);
  assert.deepEqual(api.signals, ["SIGTERM"]);
  assert.deepEqual(exits, []);

  restartTimer.callback();

  assert.equal(children.length, 2);
  assert.deepEqual(exits, []);
  assert.equal(api.closed, false);

  api.emit("close", 0, "SIGTERM");
  assert.deepEqual(exits, [0]);
});

test("shutdown logs and force-kills only children still open after the timeout", () => {
  const { supervisor, children, timers, exits, logs, setNow } = createHarness();
  supervisor.start();

  const [api, worker] = children;
  const shutdownRequestedAt = 5_000;
  const deadlineReachedAt = 17_345;
  setNow(shutdownRequestedAt);
  supervisor.stop("SIGTERM");
  worker.emit("close", 0, "SIGTERM");

  assert.deepEqual(api.signals, ["SIGTERM"]);
  assert.deepEqual(worker.signals, ["SIGTERM"]);
  assert.equal(api.closed, false);
  assert.equal(worker.closed, true);

  const shutdownTimer = timers.find((timer) => timer.delayMs === 12_000);
  assert.ok(shutdownTimer);
  assert.equal(shutdownTimer.cleared, false);

  setNow(deadlineReachedAt);
  shutdownTimer.callback();

  assert.deepEqual(api.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(worker.signals, ["SIGTERM"]);
  assert.deepEqual(
    logs.error.find(([, message]) => message === "Supervised shutdown timed out"),
    [
      {
        signal: "SIGTERM",
        services: ["api"],
        shutdownDurationMs: deadlineReachedAt - shutdownRequestedAt,
      },
      "Supervised shutdown timed out",
    ],
  );
  assert.deepEqual(exits, [1]);
});

test("shutdown timeout log includes every active service", () => {
  const { supervisor, children, timers, exits, logs } = createHarness();
  supervisor.start();

  const [api, worker] = children;
  supervisor.stop("SIGTERM");

  assert.equal(api.closed, false);
  assert.equal(worker.closed, false);

  const shutdownTimer = timers.find((timer) => timer.delayMs === 12_000);
  assert.ok(shutdownTimer);
  shutdownTimer.callback();

  assert.deepEqual(api.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(worker.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(
    logs.error.find(([, message]) => message === "Supervised shutdown timed out"),
    [
      {
        signal: "SIGTERM",
        services: ["api", "worker"],
        shutdownDurationMs: 0,
      },
      "Supervised shutdown timed out",
    ],
  );
  assert.deepEqual(exits, [1]);
});

test("shutdown timeout duration is measured from the shutdown request", () => {
  const { supervisor, timers, logs, setNow } = createHarness();
  supervisor.start();

  const shutdownRequestedAt = 5_000;
  const deadlineReachedAt = 17_345;
  setNow(shutdownRequestedAt);
  supervisor.stop("SIGTERM");

  const shutdownTimer = timers.find((timer) => timer.delayMs === 12_000);
  assert.ok(shutdownTimer);

  setNow(deadlineReachedAt);
  shutdownTimer.callback();

  assert.deepEqual(
    logs.error.find(([, message]) => message === "Supervised shutdown timed out"),
    [
      {
        signal: "SIGTERM",
        services: ["api", "worker"],
        shutdownDurationMs: deadlineReachedAt - shutdownRequestedAt,
      },
      "Supervised shutdown timed out",
    ],
  );
});

test("repeated shutdown requests keep the original timeout and signal", () => {
  const { supervisor, children, timers, exits } = createHarness();
  supervisor.start();

  const [api, worker] = children;
  supervisor.stop("SIGTERM");
  const shutdownTimer = timers.find((timer) => timer.delayMs === 12_000);
  assert.ok(shutdownTimer);

  supervisor.stop("SIGINT");

  assert.equal(timers.filter((timer) => timer.delayMs === 12_000).length, 1);
  assert.equal(shutdownTimer.cleared, false);
  assert.deepEqual(api.signals, ["SIGTERM"]);
  assert.deepEqual(worker.signals, ["SIGTERM"]);

  shutdownTimer.callback();

  assert.deepEqual(api.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(worker.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(exits, [1]);
  assert.deepEqual(
    timers.filter((timer) => timer.delayMs === 12_000),
    [shutdownTimer],
  );
});

test("late child closes cannot turn a timed-out shutdown into success", () => {
  const { supervisor, children, timers, exits } = createHarness();
  supervisor.start();

  const [api, worker] = children;
  supervisor.stop("SIGTERM");
  const shutdownTimer = timers.find((timer) => timer.delayMs === 12_000);
  assert.ok(shutdownTimer);

  shutdownTimer.callback();
  assert.deepEqual(exits, [1]);

  worker.emit("close", null, "SIGKILL");
  api.emit("close", null, "SIGKILL");

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
