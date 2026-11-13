import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import {
  db,
  facilitiesTable,
  facilityMembersTable,
  facilityStationLayoutsTable,
  pool,
} from "@workspace/db";
import { issueV2Session } from "../src/lib/v2-session";

const actorId = `pilot-verification-${randomUUID()}`;
const clerkSessionId = `pilot-session-${randomUUID()}`;
const session = issueV2Session(actorId, clerkSessionId);
const childBundle = process.env.PILOT_HTTP_CHILD_BUNDLE;
assert.ok(childBundle, "The pilot verification runner must build its test server.");

let facilityId: string | undefined;
let child: ChildProcess | undefined;
let origin = "";
let cookie = "";

after(async () => {
  await stopServer();
  if (facilityId) {
    await db.delete(facilitiesTable).where(eq(facilitiesTable.id, facilityId));
  }
  await pool.end();
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function waitForServer(process: ChildProcess) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`Pilot test server exited with code ${process.exitCode}.`);
    }
    try {
      const response = await fetch(`${origin}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.status === 200) {
        const health = await response.json() as {
          api?: string;
          database?: string;
        };
        if (health.api === "ok" && health.database === "ok") return;
      }
    } catch {
      // The child is still starting or reconnecting; retry until the deadline.
    }
    await delay(200);
  }
  throw new Error("Pilot test server did not become healthy within 15 seconds.");
}

async function startServer() {
  const port = await freePort();
  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [childBundle!], {
    env: {
      ...process.env,
      PILOT_HTTP_PORT: String(port),
      PILOT_ACTOR_ID: actorId,
      PILOT_CLERK_SESSION_ID: clerkSessionId,
    },
    stdio: "inherit",
  });
  await waitForServer(child);
}

async function stopServer() {
  if (!child) return;
  const current = child;
  child = undefined;
  if (current.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => current.once("exit", () => resolve()));
  current.kill("SIGTERM");
  await Promise.race([exited, delay(5_000)]);
  if (current.exitCode === null) {
    current.kill("SIGKILL");
    await exited;
  }
}

async function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  headers.set("origin", origin);
  if (init.method && init.method !== "GET") {
    headers.set("content-type", "application/json");
    headers.set("x-csrf-token", session.csrfToken);
  }
  return fetch(`${origin}${path}`, { ...init, headers });
}

async function sendCommand(
  runId: string,
  commandType: "start" | "pause" | "resume" | "complete",
  expectedRevision: number,
) {
  return request(`/v2/runs/${runId}/commands`, {
    method: "POST",
    body: JSON.stringify({
      commandId: randomUUID(),
      commandType,
      expectedRevision,
    }),
  });
}

test("development pilot check verifies auth, line timer, station counts, and restart persistence", {
  timeout: 90_000,
}, async () => {
  const [facility] = await db
    .insert(facilitiesTable)
    .values({ name: "Disposable pilot verification facility" })
    .returning({ id: facilitiesTable.id });
  facilityId = facility.id;
  await db.insert(facilityMembersTable).values({
    facilityId,
    userId: actorId,
    role: "owner",
  });
  await db.insert(facilityStationLayoutsTable).values({
    facilityId,
    revision: 0,
    stations: [
      {
        id: "pilot-prep",
        name: "Pilot prep",
        area: "dough_sauce_prep",
        isActive: true,
      },
      {
        id: "pilot-line",
        name: "Pilot line",
        area: "production_line",
        isActive: true,
      },
    ],
  });

  cookie = `v2_session=${session.token}`;
  await startServer();

  const health = await fetch(`${origin}/healthz`);
  assert.equal(health.status, 200, "the API and disposable database should be healthy");

  const unauthenticated = await fetch(`${origin}/v2/runs`);
  assert.equal(unauthenticated.status, 401, "run data must remain behind V2 session auth");

  const requestId = randomUUID();
  const createBody = {
    requestId,
    setupSnapshot: { label: "Automatic pilot verification run", targetCases: 24 },
  };
  const createdResponse = await request("/v2/runs", {
    method: "POST",
    body: JSON.stringify(createBody),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json() as {
    run: { id: string; status: string; revision: number };
  };
  assert.equal(created.run.status, "planned");
  assert.equal(created.run.revision, 0);

  const replayResponse = await request("/v2/runs", {
    method: "POST",
    body: JSON.stringify(createBody),
  });
  assert.equal(replayResponse.status, 200, "a retry must return the same run");
  const replay = await replayResponse.json() as {
    replayed: boolean;
    run: { id: string };
  };
  assert.equal(replay.replayed, true);
  assert.equal(replay.run.id, created.run.id);

  const initialProgressResponse = await request(`/v2/runs/${created.run.id}/stations`);
  assert.equal(initialProgressResponse.status, 200);
  const initialProgress = await initialProgressResponse.json() as {
    stations: Array<{ stationId: string; status: string; producedCount: number }>;
  };
  assert.deepEqual(
    initialProgress.stations.map((station) => station.stationId),
    ["pilot-prep", "pilot-line"],
  );

  for (const [stationId, producedCount, preparationStatus] of [
    ["pilot-prep", 7, "ready"],
    ["pilot-line", 5, "in_progress"],
  ] as const) {
    const saved = await request(`/v2/runs/${created.run.id}/stations/${stationId}`, {
      method: "PATCH",
      body: JSON.stringify({
        commandId: randomUUID(),
        expectedRevision: 0,
        producedCount,
        preparationStatus,
      }),
    });
    assert.equal(saved.status, 200, `station progress should save for ${stationId}`);
  }

  const startedResponse = await sendCommand(created.run.id, "start", 0);
  assert.equal(startedResponse.status, 200);
  const started = await startedResponse.json() as {
    run: { status: string; revision: number };
  };
  assert.equal(started.run.status, "running");
  assert.equal(started.run.revision, 1);

  const runningProgressResponse = await request(`/v2/runs/${created.run.id}/stations`);
  const runningProgress = await runningProgressResponse.json() as {
    stations: Array<{
      stationId: string;
      status: string;
      producedCount: number;
      preparationStatus: string;
    }>;
  };
  assert.ok(runningProgress.stations.every((station) => station.status === "in_progress"));
  assert.deepEqual(
    runningProgress.stations.map(({ producedCount, preparationStatus }) => ({
      producedCount,
      preparationStatus,
    })),
    [
      { producedCount: 7, preparationStatus: "ready" },
      { producedCount: 5, preparationStatus: "in_progress" },
    ],
  );

  const pausedResponse = await sendCommand(created.run.id, "pause", 1);
  assert.equal(pausedResponse.status, 200);
  await stopServer();

  // A fresh Node process must recover the saved run and station state.
  await startServer();
  const recoveredRunResponse = await request(`/v2/runs/${created.run.id}`);
  assert.equal(recoveredRunResponse.status, 200);
  const recoveredRun = await recoveredRunResponse.json() as {
    run: { status: string; revision: number };
  };
  assert.equal(recoveredRun.run.status, "paused");
  assert.equal(recoveredRun.run.revision, 2);

  const recoveredProgressResponse = await request(`/v2/runs/${created.run.id}/stations`);
  const recoveredProgress = await recoveredProgressResponse.json() as {
    stations: Array<{ status: string; producedCount: number }>;
  };
  assert.deepEqual(
    recoveredProgress.stations.map(({ status, producedCount }) => ({ status, producedCount })),
    [
      { status: "paused", producedCount: 7 },
      { status: "paused", producedCount: 5 },
    ],
  );

  const resumedResponse = await sendCommand(created.run.id, "resume", 2);
  assert.equal(resumedResponse.status, 200);
  const completedResponse = await sendCommand(created.run.id, "complete", 3);
  assert.equal(completedResponse.status, 200);
  const completed = await completedResponse.json() as {
    run: { status: string; revision: number };
  };
  assert.equal(completed.run.status, "completed");
  assert.equal(completed.run.revision, 4);

  const completedProgressResponse = await request(`/v2/runs/${created.run.id}/stations`);
  const completedProgress = await completedProgressResponse.json() as {
    stations: Array<{ status: string; producedCount: number }>;
  };
  assert.deepEqual(
    completedProgress.stations.map(({ status, producedCount }) => ({ status, producedCount })),
    [
      { status: "completed", producedCount: 7 },
      { status: "completed", producedCount: 5 },
    ],
  );

  const listedRunsResponse = await request("/v2/runs");
  const listedRuns = await listedRunsResponse.json() as {
    runs: Array<{ id: string }>;
  };
  assert.equal(
    listedRuns.runs.filter((run) => run.id === created.run.id).length,
    1,
    "the run should appear exactly once after its idempotent retry",
  );
});
