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
  productionRunsTable,
  runEventsTable,
  runOutboxTable,
  runStationProgressTable,
  pool,
} from "@workspace/db";
import { issueV2Session } from "../src/lib/v2-session";

const actorId = `pilot-verification-${randomUUID()}`;
const clerkSessionId = `pilot-session-${randomUUID()}`;
const session = issueV2Session(actorId, clerkSessionId);
const childBundle = process.env.PILOT_HTTP_CHILD_BUNDLE;
assert.ok(childBundle, "The pilot verification runner must build its test server.");
const productionTimezone = "America/Chicago";

function productionDate(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: productionTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function previousDate(date: string) {
  const previous = new Date(`${date}T12:00:00.000Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10);
}

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
  const response = await fetch(`${origin}${path}`, { ...init, headers });
  if (response.status >= 500) {
    process.stderr.write(`Pilot request ${init.method ?? "GET"} ${path} returned ${response.status}: ${await response.clone().text()}\n`);
  }
  return response;
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

test("development pilot check verifies auth, line timer, station counts, inventory freshness, quality attention, and restart persistence", {
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

  const plannedDashboardResponse = await request("/dashboard/summary");
  assert.equal(plannedDashboardResponse.status, 200);
  const plannedDashboard = await plannedDashboardResponse.json() as {
    productionDay: { date: string; timezone: string };
    counts: { completedToday: number };
    plannedRuns: Array<{ id: string }>;
    todayCompletedRuns: Array<{ id: string }>;
  };
  assert.match(plannedDashboard.productionDay.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(plannedDashboard.productionDay.timezone, "America/Chicago");
  assert.equal(plannedDashboard.counts.completedToday, 0);
  assert.deepEqual(plannedDashboard.todayCompletedRuns, []);
  assert.ok(
    plannedDashboard.plannedRuns.some((run) => run.id === created.run.id),
    "planned runs should appear in the dashboard queue",
  );

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
      revision: number;
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

  for (const [stationId, completedCases] of [
    ["pilot-prep", 0],
    ["pilot-line", 1],
  ] as const) {
    const station = runningProgress.stations.find((item) => item.stationId === stationId);
    assert.ok(station, `saved progress should include ${stationId}`);
    const savedCount = await request(
      `/v2/runs/${created.run.id}/stations/${stationId}/count`,
      {
        method: "PUT",
        body: JSON.stringify({
          commandId: randomUUID(),
          expectedRevision: station.revision,
          completedCases,
        }),
      },
    );
    assert.equal(savedCount.status, 200, `station count should save for ${stationId}`);
  }

  const activeDashboardResponse = await request("/dashboard/summary");
  assert.equal(activeDashboardResponse.status, 200);
  const activeDashboard = await activeDashboardResponse.json() as {
    activeRunProgress: Array<{
      runId: string;
      preparationStatusCounts: {
        notStarted: number;
        inProgress: number;
        ready: number;
        notRequired: number;
      };
      areas: Array<{
        area: string;
        stationCount: number;
        countedStations: number;
        lowestReportedCases: number | null;
      }>;
    }>;
  };
  const activeProgress = activeDashboard.activeRunProgress.find(
    (item) => item.runId === created.run.id,
  );
  assert.ok(activeProgress, "active run progress should appear in the dashboard");
  assert.deepEqual(
    activeProgress.areas.map(({ area, stationCount, countedStations, lowestReportedCases }) => ({
      area,
      stationCount,
      countedStations,
      lowestReportedCases,
    })).sort((left, right) => left.area.localeCompare(right.area)),
    [
      {
        area: "dough_sauce_prep",
        stationCount: 1,
        countedStations: 1,
        lowestReportedCases: 0,
      },
      {
        area: "production_line",
        stationCount: 1,
        countedStations: 1,
        lowestReportedCases: 1,
      },
    ],
  );
  assert.deepEqual(activeProgress.preparationStatusCounts, {
    notStarted: 0,
    inProgress: 1,
    ready: 1,
    notRequired: 0,
  });

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

  const completedDashboardResponse = await request("/dashboard/summary");
  const completedDashboardText = await completedDashboardResponse.text();
  if (completedDashboardResponse.status !== 200) {
    throw new Error(
      `Completed-day summary returned ${completedDashboardResponse.status}: ${completedDashboardText}`,
    );
  }
  const completedDashboard = JSON.parse(completedDashboardText) as {
    counts: { completedToday: number };
    todayCompletedRuns: Array<{ id: string }>;
  };
  assert.equal(completedDashboard.counts.completedToday, 1);
  assert.deepEqual(
    completedDashboard.todayCompletedRuns.map((run) => run.id),
    [created.run.id],
    "the new production day summary should include the completed run",
  );

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

  const [inventoryRun] = await db
    .insert(productionRunsTable)
    .values({
      facilityId,
      name: "Automatic inventory verification run",
      targetCases: 2,
      status: "running",
      revision: 1,
      productSnapshot: {
        id: randomUUID(),
        brand: "Pilot",
        flavor: "Inventory fixture",
        revision: 1,
        productData: {},
        runRequirements: {
          version: 1,
          productLabel: "Pilot Inventory fixture",
          profileRevision: 1,
          nameRevision: 1,
          targetCases: 2,
          unitsPerCase: 1,
          casePackSource: "Synthetic pilot fixture",
          totalPizzas: 2,
          status: "ready",
          options: { unitsPerCase: 1 },
          sections: [],
          sectionId: null,
          recipes: [],
          items: [
            {
              id: "pilot-ingredient",
              name: "Pilot ingredient",
              originalName: "Pilot ingredient",
              source: "Synthetic pilot fixture",
              ingredientRole: "ingredient",
              sourceCoordinates: { sheet: "Synthetic pilot fixture", row: 1, nameColumn: "A" },
              station: "Pilot line",
              stationArea: "production_line",
              amountChoices: [],
              amountColumn: "Use",
              usageUnit: "lb",
              perPizza: 1,
              totalRequired: 2,
              recipeId: null,
              recipeSource: null,
              directIngredient: true,
              batchColumn: null,
              batchUnit: null,
              batchYield: null,
              batchesExact: null,
              wholeBatches: null,
              remainder: null,
              ingredients: [],
              instructions: [],
              issues: [],
            },
          ],
          batchPreparation: [],
          preparation: [],
          preparationItems: [{
            id: "pull_pilot-test-item",
            name: "Pilot premix",
            instruction: "Move from freezer to cooler",
            source: "Synthetic premix workbook · Prep sheet · row 12",
            sourceRow: 12,
            sourceColumn: "C",
            daysEarly: 2,
          }],
          packaging: [],
          issues: [],
        },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      createdBy: actorId,
    })
    .returning({ id: productionRunsTable.id });
  const pullTasksPath = `/v2/runs/${inventoryRun.id}/preparation-tasks`;
  const pullTasksInitialResponse = await request(pullTasksPath);
  assert.equal(pullTasksInitialResponse.status, 200);
  const pullTasksInitial = await pullTasksInitialResponse.json() as {
    tasks: Array<{ id: string; status: string; revision: number; daysEarly: number | null }>;
  };
  assert.deepEqual(pullTasksInitial.tasks, [{
    id: "pull_pilot-test-item",
    name: "Pilot premix",
    instruction: "Move from freezer to cooler",
    source: "Synthetic premix workbook · Prep sheet · row 12",
    sourceRow: 12,
    sourceColumn: "C",
    daysEarly: 2,
    status: "not_started",
    revision: 0,
    updatedAt: null,
  }]);
  const pullCommandId = randomUUID();
  const pullUpdate = {
    commandId: pullCommandId,
    expectedRevision: 0,
    status: "in_progress",
  };
  const pullStartedResponse = await request(`${pullTasksPath}/pull_pilot-test-item`, {
    method: "PATCH",
    body: JSON.stringify(pullUpdate),
  });
  assert.equal(pullStartedResponse.status, 200);
  const pullStarted = await pullStartedResponse.json() as {
    replayed: boolean;
    task: { id: string; status: string; revision: number; updatedAt: string };
  };
  assert.equal(pullStarted.replayed, false);
  assert.equal(pullStarted.task.id, "pull_pilot-test-item");
  assert.equal(pullStarted.task.status, "in_progress");
  assert.equal(pullStarted.task.revision, 1);
  assert.ok(Number.isFinite(Date.parse(pullStarted.task.updatedAt)));
  const pullReplayResponse = await request(`${pullTasksPath}/pull_pilot-test-item`, {
    method: "PATCH",
    body: JSON.stringify(pullUpdate),
  });
  assert.equal(pullReplayResponse.status, 200);
  const pullReplay = await pullReplayResponse.json() as {
    replayed: boolean;
    task: { status: string; revision: number };
  };
  assert.equal(pullReplay.replayed, true);
  const pullCompletedResponse = await request(`${pullTasksPath}/pull_pilot-test-item`, {
    method: "PATCH",
    body: JSON.stringify({
      commandId: randomUUID(),
      expectedRevision: 1,
      status: "completed",
    }),
  });
  assert.equal(pullCompletedResponse.status, 200);
  const pullCompleted = await pullCompletedResponse.json() as {
    task: { status: string; revision: number };
  };
  assert.equal(pullCompleted.task.status, "completed");
  assert.equal(pullCompleted.task.revision, 2);
  const stalePullUpdate = await request(`${pullTasksPath}/pull_pilot-test-item`, {
    method: "PATCH",
    body: JSON.stringify({
      commandId: randomUUID(),
      expectedRevision: 0,
      status: "not_started",
    }),
  });
  assert.equal(stalePullUpdate.status, 409);
  const initialInventoryCountAt = new Date();
  await db.insert(runStationProgressTable).values({
    runId: inventoryRun.id,
    stationId: "pilot-line",
    stationName: "Pilot line",
    stationArea: "production_line",
    stationOrder: 1,
    status: "in_progress",
    completedCases: 0,
    producedCount: 0,
    preparationStatus: "ready",
    revision: 0,
    countUpdatedAt: initialInventoryCountAt,
    updatedAt: initialInventoryCountAt,
    updatedBy: actorId,
  });
  const usageBeforeCountResponse = await request(
    `/v2/runs/${inventoryRun.id}/inventory-usage`,
  );
  assert.equal(usageBeforeCountResponse.status, 200);
  const usageBeforeCount = await usageBeforeCountResponse.json() as {
    items: Array<{ ingredientName: string; proposedQuantity: number | null }>;
  };
  assert.equal(
    usageBeforeCount.items.find((item) => item.ingredientName === "Pilot ingredient")?.proposedQuantity,
    0,
    "no completed production should estimate zero ingredient use",
  );
  const changedInventoryCountResponse = await request(
    `/v2/runs/${inventoryRun.id}/stations/pilot-line/count`,
    {
      method: "PUT",
      body: JSON.stringify({
        commandId: randomUUID(),
        expectedRevision: 0,
        completedCases: 1,
      }),
    },
  );
  assert.equal(changedInventoryCountResponse.status, 200);
  const usageAfterCountResponse = await request(
    `/v2/runs/${inventoryRun.id}/inventory-usage`,
  );
  assert.equal(usageAfterCountResponse.status, 200);
  const usageAfterCount = await usageAfterCountResponse.json() as {
    items: Array<{ ingredientName: string; proposedQuantity: number | null }>;
  };
  assert.equal(
    usageAfterCount.items.find((item) => item.ingredientName === "Pilot ingredient")?.proposedQuantity,
    1,
    "estimated ingredient use should recalculate after a saved station count changes",
  );
  await db
    .update(productionRunsTable)
    .set({ status: "completed" })
    .where(eq(productionRunsTable.id, inventoryRun.id));

  const qualityMeasurementResponse = await request(
    `/v2/runs/${inventoryRun.id}/quality-checks`,
    {
      method: "POST",
      body: JSON.stringify({
        commandId: randomUUID(),
        items: [{ checkId: "ingredient:pilot-ingredient", observedOz: 20 }],
      }),
    },
  );
  const qualityMeasurementText = await qualityMeasurementResponse.text();
  if (qualityMeasurementResponse.status !== 200) {
    throw new Error(
      `Quality measurement returned ${qualityMeasurementResponse.status}: ${qualityMeasurementText}`,
    );
  }
  const countedAt = new Date();
  await db
    .update(runStationProgressTable)
    .set({
      status: "completed",
      updatedAt: countedAt,
    })
    .where(eq(runStationProgressTable.runId, inventoryRun.id));

  const openingStockResponse = await request("/v2/inventory", {
    method: "POST",
    body: JSON.stringify({
      commandId: randomUUID(),
      ingredientName: "Pilot ingredient",
      unit: "lb",
      delta: 3,
      note: "Synthetic pilot opening stock",
      correctsEntryId: null,
    }),
  });
  assert.equal(openingStockResponse.status, 201);

  const openingInventoryResponse = await request("/v2/inventory");
  assert.equal(openingInventoryResponse.status, 200);
  const openingInventory = await openingInventoryResponse.json() as {
    items: Array<{ ingredientName: string; unit: string; onHand: number; revision: number }>;
    entries: Array<{ kind: string; delta: number }>;
  };
  const openingIngredient = openingInventory.items.find(
    (item) => item.ingredientName === "Pilot ingredient" && item.unit === "lb",
  );
  assert.ok(openingIngredient, "opening count should create a facility inventory balance");
  assert.equal(openingIngredient.onHand, 3);
  assert.equal(openingInventory.entries.filter((entry) => entry.kind === "stock_adjustment").length, 1);

  const plannedInventoryRunResponse = await request("/v2/runs", {
    method: "POST",
    body: JSON.stringify({
      requestId: randomUUID(),
      setupSnapshot: { label: "Planned-only inventory verification run", targetCases: 2 },
    }),
  });
  assert.equal(plannedInventoryRunResponse.status, 201);
  const plannedInventoryRun = await plannedInventoryRunResponse.json() as {
    run: { id: string; status: string };
  };
  assert.equal(plannedInventoryRun.run.status, "planned");
  const plannedUsageResponse = await request(
    `/v2/runs/${plannedInventoryRun.run.id}/inventory-usage`,
    {
      method: "POST",
      body: JSON.stringify({
        commandId: randomUUID(),
        items: [{
          id: "pilot-ingredient",
          actualUsed: 1,
          expectedInventoryRevision: openingIngredient.revision,
        }],
      }),
    },
  );
  assert.equal(plannedUsageResponse.status, 409, "planned runs cannot deduct ingredient stock");
  const inventoryAfterPlannedAttemptResponse = await request("/v2/inventory");
  assert.equal(inventoryAfterPlannedAttemptResponse.status, 200);
  const inventoryAfterPlannedAttempt = await inventoryAfterPlannedAttemptResponse.json() as {
    items: Array<{ ingredientName: string; unit: string; onHand: number; revision: number }>;
    entries: Array<{ kind: string; delta: number }>;
  };
  const unchangedIngredient = inventoryAfterPlannedAttempt.items.find(
    (item) => item.ingredientName === "Pilot ingredient" && item.unit === "lb",
  );
  assert.deepEqual(
    unchangedIngredient && {
      onHand: unchangedIngredient.onHand,
      revision: unchangedIngredient.revision,
    },
    { onHand: openingIngredient.onHand, revision: openingIngredient.revision },
    "a planned run must not change inventory balance or revision",
  );
  assert.equal(
    inventoryAfterPlannedAttempt.entries.length,
    openingInventory.entries.length,
    "a planned run must not create an inventory transaction",
  );

  const usagePath = `/v2/runs/${inventoryRun.id}/inventory-usage`;
  const reviewedUsageResponse = await request(usagePath);
  assert.equal(reviewedUsageResponse.status, 200);
  const reviewedUsage = await reviewedUsageResponse.json() as {
    canConfirm: boolean;
    items: Array<{ id: string; inventoryOnHand: number | null; inventoryRevision: number | null }>;
  };
  assert.equal(reviewedUsage.canConfirm, true);
  const reviewedIngredient = reviewedUsage.items.find((item) => item.inventoryOnHand !== null);
  assert.ok(reviewedIngredient);
  assert.equal(reviewedIngredient.inventoryOnHand, 3);

  const stockChangedResponse = await request("/v2/inventory", {
    method: "POST",
    body: JSON.stringify({
      commandId: randomUUID(),
      ingredientName: "Pilot ingredient",
      unit: "lb",
      delta: 1,
      note: "Change stock after review",
      correctsEntryId: null,
    }),
  });
  assert.equal(stockChangedResponse.status, 201);

  const staleUsageResponse = await request(usagePath, {
    method: "POST",
    body: JSON.stringify({
      commandId: randomUUID(),
      items: [{
        id: reviewedIngredient.id,
        actualUsed: 5,
        expectedInventoryRevision: reviewedIngredient.inventoryRevision,
      }],
    }),
  });
  assert.equal(staleUsageResponse.status, 409);
  const freshUsageResponse = await request(usagePath);
  const freshUsage = await freshUsageResponse.json() as {
    items: Array<{ id: string; inventoryOnHand: number | null; inventoryRevision: number | null }>;
    reconciliation: unknown;
  };
  const freshIngredient = freshUsage.items.find((item) => item.inventoryOnHand !== null);
  assert.ok(freshIngredient);
  assert.equal(freshIngredient.inventoryOnHand, 4);
  assert.equal(freshUsage.reconciliation, null, "stale confirmation must not deduct stock");

  const confirmedUsageResponse = await request(usagePath, {
    method: "POST",
    body: JSON.stringify({
      commandId: randomUUID(),
      items: [{
        id: freshIngredient.id,
        actualUsed: 5,
        expectedInventoryRevision: freshIngredient.inventoryRevision,
      }],
    }),
  });
  assert.equal(confirmedUsageResponse.status, 200);
  const confirmedUsage = await confirmedUsageResponse.json() as {
    items: Array<{ inventoryOnHand: number | null; actualUsed: number | null }>;
  };
  assert.equal(confirmedUsage.items.find((item) => item.actualUsed !== null)?.inventoryOnHand, -1);

  const attentionDashboardResponse = await request("/dashboard/summary");
  const attentionDashboardText = await attentionDashboardResponse.text();
  if (attentionDashboardResponse.status !== 200) {
    throw new Error(
      `Dashboard attention summary returned ${attentionDashboardResponse.status}: ${attentionDashboardText}`,
    );
  }
  const attentionDashboard = JSON.parse(attentionDashboardText) as {
    qualityAttention: Array<{
      runId: string;
      runLabel: string;
      runStatus: string;
      failedChecks: number;
      unresolvedChecks: number;
    }>;
  };
  assert.deepEqual(
    attentionDashboard.qualityAttention.find((item) => item.runId === inventoryRun.id),
    {
      runId: inventoryRun.id,
      runLabel: "Automatic inventory verification run",
      runStatus: "completed",
      failedChecks: 1,
      unresolvedChecks: 1,
    },
  );

  const today = productionDate(new Date());
  const yesterday = previousDate(today);
  const priorStart = new Date(`${yesterday}T15:00:00.000Z`);
  const priorPause = new Date(`${yesterday}T17:00:00.000Z`);
  const [stalePlanned] = await db
    .insert(productionRunsTable)
    .values({
      facilityId,
      name: "Midnight rollover planned test",
      status: "planned",
      scheduledFor: yesterday,
      createdBy: actorId,
    })
    .returning({ id: productionRunsTable.id });
  const [staleRunning] = await db
    .insert(productionRunsTable)
    .values({
      facilityId,
      name: "Midnight rollover running test",
      status: "running",
      revision: 4,
      startedAt: priorStart,
      createdBy: actorId,
    })
    .returning({ id: productionRunsTable.id });
  const [stalePaused] = await db
    .insert(productionRunsTable)
    .values({
      facilityId,
      name: "Midnight rollover paused test",
      status: "paused",
      revision: 6,
      startedAt: priorStart,
      pausedAt: priorPause,
      pauseIntervals: [{ startedAt: priorPause.toISOString(), endedAt: null }],
      createdBy: actorId,
    })
    .returning({ id: productionRunsTable.id });

  const rolloverDashboardResponse = await request("/dashboard/summary");
  assert.equal(rolloverDashboardResponse.status, 200);
  const rolloverDashboard = await rolloverDashboardResponse.json() as {
    productionDay: { date: string };
    activeRuns: Array<{ id: string }>;
    plannedRuns: Array<{ id: string }>;
  };
  assert.equal(rolloverDashboard.productionDay.date, today);
  assert.ok(!rolloverDashboard.activeRuns.some((run) => run.id === staleRunning.id));
  assert.ok(!rolloverDashboard.activeRuns.some((run) => run.id === stalePaused.id));
  assert.ok(!rolloverDashboard.plannedRuns.some((run) => run.id === stalePlanned.id));

  const rolloverRunsResponse = await request("/v2/runs?limit=100");
  assert.equal(rolloverRunsResponse.status, 200);
  const rolloverRuns = await rolloverRunsResponse.json() as {
    runs: Array<{
      id: string;
      status: string;
      revision: number;
      completedAt: string | null;
      endedAt: string | null;
      pauseIntervals: Array<{ startedAt: string; endedAt: string | null }>;
    }>;
  };
  for (const [id, revision] of [
    [stalePlanned.id, 1],
    [staleRunning.id, 5],
    [stalePaused.id, 7],
  ] as const) {
    const closed = rolloverRuns.runs.find((run) => run.id === id);
    assert.ok(closed, `closed run ${id} remains in run history`);
    assert.equal(closed.status, "incomplete");
    assert.equal(closed.revision, revision);
    assert.equal(closed.completedAt, null, "an incomplete run is not recorded as completed");
    assert.ok(closed.endedAt, "the midnight close time is recorded");
    assert.equal(productionDate(new Date(closed.endedAt)), today);
    const localCloseTime = new Intl.DateTimeFormat("en-US", {
      timeZone: productionTimezone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(closed.endedAt));
    assert.equal(localCloseTime, "00:00");
    const events = await db
      .select({ action: runEventsTable.action, toStatus: runEventsTable.toStatus })
      .from(runEventsTable)
      .where(eq(runEventsTable.runId, id));
    assert.deepEqual(events, [{ action: "production_day_rollover", toStatus: "incomplete" }]);
    const outbox = await db
      .select({ runId: runOutboxTable.runId })
      .from(runOutboxTable)
      .where(eq(runOutboxTable.runId, id));
    assert.equal(outbox.length, 1, "the close is published once for other sessions");
    if (id === stalePaused.id) {
      assert.equal(closed.pauseIntervals.at(-1)?.endedAt, closed.endedAt);
    }
  }

  const retryRolloverResponse = await request("/dashboard/summary");
  assert.equal(retryRolloverResponse.status, 200);
  for (const id of [stalePlanned.id, staleRunning.id, stalePaused.id]) {
    const events = await db
      .select({ id: runEventsTable.id })
      .from(runEventsTable)
      .where(eq(runEventsTable.runId, id));
    assert.equal(events.length, 1, "repeated dashboard refresh must not duplicate rollover history");
  }
  const lateStartResponse = await sendCommand(stalePlanned.id, "start", 1);
  assert.equal(lateStartResponse.status, 409, "a run closed at midnight cannot be started later");
  const lateResumeResponse = await sendCommand(stalePaused.id, "resume", 7);
  assert.equal(lateResumeResponse.status, 409, "a run closed at midnight cannot be resumed later");
  const lateStationUpdateResponse = await request(
    `/v2/runs/${staleRunning.id}/stations/pilot-line`,
    {
      method: "PATCH",
      body: JSON.stringify({
        commandId: randomUUID(),
        expectedRevision: 0,
        producedCount: 1,
        preparationStatus: "ready",
      }),
    },
  );
  assert.equal(lateStationUpdateResponse.status, 409, "a closed run cannot accept station edits");
  const lateCountUpdateResponse = await request(
    `/v2/runs/${staleRunning.id}/stations/pilot-line/count`,
    {
      method: "PUT",
      body: JSON.stringify({
        commandId: randomUUID(),
        expectedRevision: 0,
        completedCases: 1,
      }),
    },
  );
  assert.equal(lateCountUpdateResponse.status, 409, "a closed run cannot accept new counts");
});
