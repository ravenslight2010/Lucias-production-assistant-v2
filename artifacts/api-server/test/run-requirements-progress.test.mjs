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
    proposedUsage: [],
  });
  assert.equal(result.items[1].remainingRequired, null);
  assert.equal(result.items[1].remainingCases, null);
  assert.deepEqual(plan, before, "the captured source plan remains unchanged");
});

test("dough and sauce requirements scale from their separate station areas", () => {
  const separatePlan = {
    targetCases: 100,
    items: [
      { id: "dough", station: "Dough preparation", stationArea: "dough_prep", totalRequired: 100, batchesExact: 5, batchYield: 20, ingredients: [] },
      { id: "sauce", station: "Sauce preparation", stationArea: "sauce_prep", totalRequired: 200, batchesExact: 10, batchYield: 20, ingredients: [] },
    ],
    batchPreparation: [],
  };
  const result = calculateRunRequirementsProgress(separatePlan, [
    { area: "dough_prep", completedCases: 40, recorded: true },
    { area: "sauce_prep", completedCases: 25, recorded: true },
  ]);

  assert.equal(result.items.find((item) => item.id === "dough").remainingRequired, 60);
  assert.equal(result.items.find((item) => item.id === "sauce").remainingRequired, 150);
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

test("usage proposals retain source units and distinguish saved recipe use from unresolved lines", () => {
  const savedPlan = {
    targetCases: 100,
    items: [
      {
        id: "direct-cheese",
        name: "Cheese",
        originalName: "Cheese",
        source: "Spec.xlsx · row 14",
        station: "Production line",
        stationArea: "production_line",
        amountColumn: "Amount",
        usageUnit: "oz",
        perPizza: 1.25,
        totalRequired: 50,
        directIngredient: true,
        issues: [],
        ingredients: [],
      },
      {
        id: "batch:dough:2",
        name: "Dough",
        originalName: "Dough",
        source: "Dough.xlsx · Flour row 8",
        station: "Dough & sauce preparation",
        stationArea: "dough_sauce_prep",
        amountColumn: "Usage",
        batchColumn: 2,
        batchUnit: "lb",
        totalRequired: 20,
        batchesExact: 2,
        batchYield: 10,
        recipeId: "dough",
        directIngredient: false,
        issues: [],
        ingredients: [{
          name: "Flour",
          unit: "lb",
          perBatch: 10,
          exactRequired: 20,
          wholeBatchRequired: 20,
        }],
      },
      {
        id: "unresolved",
        name: "Unknown ingredient",
        originalName: "Unknown ingredient",
        source: "Spec.xlsx · row 15",
        station: "Production line",
        stationArea: "production_line",
        amountColumn: null,
        usageUnit: null,
        totalRequired: null,
        recipeId: null,
        directIngredient: false,
        issues: ["Confirm the source unit."],
        ingredients: [],
      },
    ],
    batchPreparation: [],
  };
  const result = calculateRunRequirementsProgress(savedPlan, [
    { area: "production_line", completedCases: 25, recorded: true },
    { area: "dough_sauce_prep", completedCases: 40, recorded: true },
  ]);
  const proposals = result.items.flatMap((item) => item.proposedUsage);

  assert.deepEqual(proposals.map(({ ingredientName, unit, sourceAmount, quantityBasis, proposedQuantity, blockedReason, source }) => ({
    ingredientName, unit, sourceAmount, quantityBasis, proposedQuantity, blockedReason, source,
  })), [
    {
      ingredientName: "Cheese",
      unit: "oz",
      sourceAmount: 1.25,
      quantityBasis: "per_pizza",
      proposedQuantity: 12.5,
      blockedReason: null,
      source: "Spec.xlsx · row 14",
    },
    {
      ingredientName: "Flour",
      unit: "lb",
      sourceAmount: 10,
      quantityBasis: "per_batch",
      proposedQuantity: 8,
      blockedReason: null,
      source: "Dough.xlsx · Flour row 8",
    },
    {
      ingredientName: "Unknown ingredient",
      unit: "",
      sourceAmount: null,
      quantityBasis: "unresolved",
      proposedQuantity: null,
      blockedReason: "Confirm the source unit.",
      source: "Spec.xlsx · row 15",
    },
  ]);
  assert.equal(savedPlan.items[0].totalRequired, 50, "the saved plan remains unchanged");
});
