import assert from "node:assert/strict";
import test from "node:test";
import { toContractRun } from "../src/lib/run-contract.ts";
// Import the generated schema directly for native Node TypeScript execution.
import {
  ApplyRunCommandResponse,
  CreateRunResponse,
  GetRunResponse,
  ListRunsResponse,
} from "../../../lib/api-zod/src/generated/api.ts";

const profileId = "6d43e536-d7c4-4eda-af3a-31d512ffeb9e";
const runId = "f4c58fa4-ff4b-481d-8b31-3aad34c6fd50";
const at = new Date("2026-11-12T01:00:00Z");
const legacySnapshot = {
  id: profileId, brand: "Smoke", flavor: "Sauce", revision: 0,
  productData: { source: "preserved" }, createdAt: at, updatedAt: at,
};
const makeRun = (productSnapshot = legacySnapshot) => ({
  id: runId, name: "Smoke / Sauce", status: "planned", revision: 0,
  createdAt: at, updatedAt: at, scheduledFor: null, scheduleNotes: null,
  scheduleSource: null, startedAt: null, pausedAt: null, resumedAt: null,
  completedAt: null, targetCases: 2, productProfileId: profileId,
  productSnapshot, pauseIntervals: [],
});

test("legacy captured profiles satisfy all run response contracts without rewriting saved snapshots", () => {
  const stored = structuredClone(makeRun());
  const before = structuredClone(stored);
  const run = toContractRun(stored);
  assert.equal(run.productSnapshot.mergedIntoId, null);
  assert.deepEqual(run.productSnapshot.productData, legacySnapshot.productData);
  assert.deepEqual(stored, before);
  assert.equal(Object.hasOwn(stored.productSnapshot, "mergedIntoId"), false);
  assert.doesNotThrow(() => CreateRunResponse.parse({ outcome: "created", replayed: false, run }));
  assert.doesNotThrow(() => CreateRunResponse.parse({ outcome: "created", replayed: true, run }));
  assert.doesNotThrow(() => ListRunsResponse.parse({ runs: [run] }));
  assert.doesNotThrow(() => GetRunResponse.parse({ run }));
  for (const status of ["running", "paused", "completed"]) {
    assert.doesNotThrow(() => ApplyRunCommandResponse.parse({
      outcome: "accepted", replayed: false, commandId: "smoke-command",
      run: { ...run, status, revision: 1 },
    }));
  }
});

test("explicit captured merge markers and null product snapshots remain unchanged", () => {
  const marked = { ...legacySnapshot, mergedIntoId: runId };
  assert.deepEqual(toContractRun(makeRun(marked)).productSnapshot, marked);
  assert.equal(toContractRun(makeRun(null)).productSnapshot, null);
  assert.doesNotThrow(() => GetRunResponse.parse({ run: toContractRun(makeRun(null)) }));
});

test("normalization does not hide malformed captured product data", () => {
  const malformed = { ...legacySnapshot, revision: "not-a-number" };
  assert.throws(() => GetRunResponse.parse({ run: toContractRun(makeRun(malformed)) }));
});
