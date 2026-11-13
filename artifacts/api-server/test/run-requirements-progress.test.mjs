import assert from "node:assert/strict";
import test from "node:test";
import { calculateRunRequirementsProgress } from "../src/lib/run-requirements-progress.ts";

const plan = {
  targetCases: 100,
  items: [
    {
      id: "line-cheese",
      station: "Production line",
      stationArea: "production_line",
      totalRequired: 200,
      batchesExact: 3,
      batchYield: 10,
      ingredients: [
        {
          name: "Cheese",
          unit: "lb",
          perBatch: 5,
          exactRequired: 15,
          wholeBatchRequired: 20,
        },
      ],
    },
    {
      id: "prep-sauce",
      station: "Dough & sauce preparation",
      stationArea: "dough_sauce_prep",
      totalRequired: null,
      batchesExact: null,
      batchYield: null,
      ingredients: [],
    },
  ],
  batchPreparation: [],
};

test("remaining requirements use the lowest reported case count in their matching area", () => {
  const before = structuredClone(plan);
  const result = calculateRunRequirementsProgress(plan, [
    { area: "production_line", completedCases: 30, recorded: true },
    { area: "production_line", completedCases: 25, recorded: true },
    { area: "production_line", completedCases: 0, recorded: false },
  ]);

  assert.equal(result.areas.find((area) => area.area === "production_line").completedCases, 25);
  assert.equal(result.areas.find((area) => area.area === "production_line").stationCount, 2);
  assert.equal(result.areas.find((area) => area.area === "production_line").remainingCases, 75);
  assert.deepEqual(result.items[0], {
    id: "line-cheese",
    area: "production_line",
    completedCases: 25,
    remainingCases: 75,
    remainingRequired: 150,
    remainingBatchesExact: 2.25,
    remainingWholeBatches: 3,
    remainingRemainder: 7.5,
    remainingIngredients: [{
      name: "Cheese",
      unit: "lb",
      perBatch: 5,
      exactRequired: 11.25,
      wholeBatchRequired: 15,
    }],
  });
  assert.equal(result.items[1].remainingRequired, null);
  assert.equal(result.items[1].remainingCases, null);
  assert.deepEqual(plan, before, "the captured source plan remains unchanged");
});

test("zero remaining cases produces zero requirements without inventing unresolved values", () => {
  const result = calculateRunRequirementsProgress(plan, [
    { area: "production_line", completedCases: 100, recorded: true },
    { area: "dough_sauce_prep", completedCases: 100, recorded: true },
  ]);

  assert.equal(result.items[0].remainingRequired, 0);
  assert.equal(result.items[0].remainingBatchesExact, 0);
  assert.equal(result.items[0].remainingWholeBatches, 0);
  assert.equal(result.items[0].remainingRemainder, 0);
  assert.equal(result.items[1].remainingRequired, null);
});

test("missing station counts are visibly unresolved rather than treated as completed", () => {
  const result = calculateRunRequirementsProgress(plan, []);
  const line = result.areas.find((area) => area.area === "production_line");

  assert.equal(line.stationCount, 0);
  assert.equal(line.completedCases, null);
  assert.equal(line.remainingCases, null);
  assert.equal(result.items[0].remainingRequired, null);
});
