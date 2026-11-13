import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRunStationProgressRows,
  stationStatusForRun,
  storedStationStatusForRun,
} from "../src/lib/run-station-progress-logic.ts";
import { DEFAULT_FACILITY_STATIONS } from "../src/lib/facility-stations.ts";
import {
  GetRunStationProgressResponse,
  UpdateRunStationCountBody,
} from "../../../lib/api-zod/src/generated/api.ts";

test("run snapshots include only active stations in their submitted order", () => {
  const stations = [
    { ...DEFAULT_FACILITY_STATIONS[0], name: "Dough staging" },
    { ...DEFAULT_FACILITY_STATIONS[1], isActive: false },
    { ...DEFAULT_FACILITY_STATIONS[2], name: "Sauce prep" },
  ];

  const rows = buildRunStationProgressRows("run-1", stations);

  assert.deepEqual(
    rows.map((row) => ({
      runId: row.runId,
      stationId: row.stationId,
      stationName: row.stationName,
      stationOrder: row.stationOrder,
      status: row.status,
      producedCount: row.producedCount,
      preparationStatus: row.preparationStatus,
      completedCases: row.completedCases,
      countUpdatedAt: row.countUpdatedAt,
      revision: row.revision,
      updatedAt: row.updatedAt,
    })),
    [
      {
        runId: "run-1",
        stationId: stations[0].id,
        stationName: "Dough staging",
        stationOrder: 0,
        status: "not_started",
        producedCount: 0,
        preparationStatus: "not_started",
        completedCases: 0,
        countUpdatedAt: null,
        revision: 0,
        updatedAt: null,
      },
      {
        runId: "run-1",
        stationId: stations[2].id,
        stationName: "Sauce prep",
        stationOrder: 1,
        status: "not_started",
        producedCount: 0,
        preparationStatus: "not_started",
        completedCases: 0,
        countUpdatedAt: null,
        revision: 0,
        updatedAt: null,
      },
    ],
  );
});

test("each station status mirrors the production line timer", () => {
  assert.deepEqual(
    ["planned", "running", "paused", "completed"].map(stationStatusForRun),
    ["not_started", "in_progress", "paused", "completed"],
  );
  assert.equal(storedStationStatusForRun("paused"), "in_progress");
});

test("line timer transitions stamp every active station together", () => {
  const timestamp = new Date("2026-11-11T10:15:00.000Z");
  const rows = buildRunStationProgressRows(
    "run-2",
    DEFAULT_FACILITY_STATIONS.slice(0, 3),
    {
      status: "in_progress",
      revision: 2,
      updatedAt: timestamp,
      updatedBy: "operator-1",
    },
  );

  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.status === "in_progress"));
  assert.ok(rows.every((row) => row.completedCases === 0));
  assert.ok(rows.every((row) => row.countUpdatedAt === null));
  assert.ok(rows.every((row) => row.revision === 2));
  assert.ok(rows.every((row) => row.updatedAt === timestamp));
  assert.ok(rows.every((row) => row.updatedBy === "operator-1"));
});

test("unknown line states keep stations waiting instead of creating false progress", () => {
  assert.equal(stationStatusForRun("unknown"), "not_started");
});

test("station count inputs require a whole nonnegative count and an expected revision", () => {
  assert.equal(UpdateRunStationCountBody.safeParse({
    expectedRevision: 3,
    completedCases: 12,
  }).success, true);
  assert.equal(UpdateRunStationCountBody.safeParse({
    expectedRevision: 3,
    completedCases: 1.5,
  }).success, false);
  assert.equal(UpdateRunStationCountBody.safeParse({
    expectedRevision: 3,
    completedCases: -1,
  }).success, false);
});

test("station progress response contract includes counts and current needs", () => {
  assert.doesNotThrow(() => GetRunStationProgressResponse.parse({
    initialized: true,
    currentRequirements: {
      targetCases: 10,
      areas: [{
        area: "production_line",
        stationCount: 1,
        completedCases: 4,
        remainingCases: 6,
      }],
      items: [{
        id: "line-cheese",
        area: "production_line",
        completedCases: 4,
        remainingCases: 6,
        remainingRequired: 12,
        remainingBatchesExact: 0.6,
        remainingWholeBatches: 1,
        remainingRemainder: 8,
        remainingIngredients: [],
      }],
    },
    stations: [{
      stationId: "line-oven",
      stationName: "Oven",
      area: "production_line",
      order: 0,
      status: "in_progress",
      revision: 4,
      producedCount: 15,
      preparationStatus: "ready",
      completedCases: 4,
      countUpdatedAt: "2026-11-12T10:00:00.000Z",
      updatedAt: "2026-11-12T09:00:00.000Z",
    }],
  }));
});
