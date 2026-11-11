import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRunStationProgressRows,
  planStationProgressUpdate,
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

test("station progress rejects stale revisions and advances only changed states", () => {
  const current = { status: "not_started", revision: 0 };

  assert.deepEqual(
    planStationProgressUpdate(current, 1, "in_progress"),
    { type: "conflict" },
  );
  assert.deepEqual(
    planStationProgressUpdate(current, 0, "not_started"),
    { type: "unchanged" },
  );
  assert.deepEqual(
    planStationProgressUpdate(current, 0, "in_progress"),
    { type: "updated", status: "in_progress", revision: 1 },
  );
});

test("station status can be corrected using the latest revision", () => {
  assert.deepEqual(
    planStationProgressUpdate(
      { status: "completed", revision: 4 },
      4,
      "in_progress",
    ),
    { type: "updated", status: "in_progress", revision: 5 },
  );
});
