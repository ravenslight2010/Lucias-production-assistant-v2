import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRunStationProgressRows,
  stationStatusForRun,
  storedStationStatusForRun,
} from "../src/lib/run-station-progress-logic.ts";
import { DEFAULT_FACILITY_STATIONS } from "../src/lib/facility-stations.ts";

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
        revision: 0,
        updatedAt: null,
      },
      {
        runId: "run-1",
        stationId: stations[2].id,
        stationName: "Sauce prep",
        stationOrder: 1,
        status: "not_started",
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
  assert.ok(rows.every((row) => row.revision === 2));
  assert.ok(rows.every((row) => row.updatedAt === timestamp));
  assert.ok(rows.every((row) => row.updatedBy === "operator-1"));
});

test("unknown line states keep stations waiting instead of creating false progress", () => {
  assert.equal(stationStatusForRun("unknown"), "not_started");
});
