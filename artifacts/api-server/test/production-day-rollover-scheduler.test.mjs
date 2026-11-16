import assert from "node:assert/strict";
import test from "node:test";
import { build as esbuild } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const bundleDirectory = await mkdtemp(
  path.join(testDirectory, "../../../lib/db/tests/.production-day-rollover-scheduler-"),
);
await esbuild({
  entryPoints: [
    path.resolve(
      testDirectory,
      "../src/lib/production-day-rollover-scheduler.ts",
    ),
  ],
  outdir: bundleDirectory,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "bundle",
});
test.after(() => rm(bundleDirectory, { recursive: true, force: true }));

const { createProductionDayRolloverScheduler } = await import(
  pathToFileURL(
    path.join(bundleDirectory, "production-day-rollover-scheduler.mjs"),
  ).href
);

test("sweeps every facility once per Chicago production day", async () => {
  let productionDay = "2026-11-14";
  const closedFacilities = [];
  const completions = [];
  const scheduler = createProductionDayRolloverScheduler({
    getProductionDay: async () => productionDay,
    getFacilityIds: async () => ["facility-a", "facility-b"],
    closeFacilityRuns: async (facilityId) => {
      closedFacilities.push(facilityId);
      return facilityId === "facility-a" ? 2 : 1;
    },
    onComplete: (result) => completions.push(result),
  });

  await scheduler();
  await scheduler();
  assert.deepEqual(closedFacilities, ["facility-a", "facility-b"]);
  assert.deepEqual(completions, [
    {
      productionDay: "2026-11-14",
      facilityCount: 2,
      closedRunCount: 3,
    },
  ]);

  productionDay = "2026-11-15";
  await scheduler();
  assert.deepEqual(closedFacilities, [
    "facility-a",
    "facility-b",
    "facility-a",
    "facility-b",
  ]);
  assert.equal(completions.length, 2);
});

test("a failed sweep retries later without marking the day complete", async () => {
  let clock = 1_000;
  let fail = true;
  let attempts = 0;
  const errors = [];
  const completions = [];
  const scheduler = createProductionDayRolloverScheduler({
    getProductionDay: async () => "2026-11-14",
    getFacilityIds: async () => ["facility-a"],
    closeFacilityRuns: async () => {
      attempts += 1;
      if (fail) throw new Error("temporary failure");
      return 1;
    },
    onComplete: (result) => completions.push(result),
    onError: (error, productionDay) => errors.push({ error, productionDay }),
    retryDelayMs: 5_000,
    now: () => clock,
  });

  await scheduler();
  await scheduler();
  assert.equal(attempts, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].productionDay, "2026-11-14");
  assert.equal(completions.length, 0);

  clock += 5_000;
  fail = false;
  await scheduler();
  assert.equal(attempts, 2);
  assert.equal(completions.length, 1);
});
