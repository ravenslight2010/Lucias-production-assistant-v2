import assert from "node:assert/strict";
import test from "node:test";
import { buildRunQualityTargets } from "../src/lib/run-quality-checks.ts";

const snapshot = () => ({
  runRequirements: {
    items: [
      {
        id: "sauce-row",
        name: "Aldo's Sauce",
        originalName: "Aldo's Sauce (made in house)",
        source: "Aldo's Pizza Specs.xlsx · OZ row 4",
        station: "Production line",
        usageUnit: "oz",
        perPizza: 4,
      },
      {
        id: "pep-row",
        name: "Pepperoni Stick",
        originalName: "Pepperoni Stick (Cured)",
        source: "Aldo's Pizza Specs.xlsx · OZ row 16",
        station: "Production line",
        usageUnit: "oz",
        perPizza: 1.1,
      },
      {
        id: "cheese-row",
        name: "Cheese mix",
        originalName: "Applicator - Aldo's Cheese Mix",
        source: "Aldo's Pizza Specs.xlsx · OZ row 5",
        station: "Production line",
        usageUnit: "oz",
        perPizza: 3.5,
      },
      {
        id: "pound-row",
        name: "Flour",
        originalName: "Flour",
        source: "Test spec.xlsx · row 20",
        station: "Production line",
        usageUnit: "lb",
        perPizza: 0.25,
      },
      {
        id: "count-row",
        name: "Whole olives",
        originalName: "Whole olives",
        source: "Test spec.xlsx · row 21",
        station: "Production line",
        usageUnit: "each",
        perPizza: 2,
      },
      {
        id: "unresolved-row",
        name: "Annotated pepperoni amount",
        originalName: "Pepperoni Stick",
        source: "Test spec.xlsx · row 22",
        station: "Production line",
        usageUnit: "oz",
        perPizza: null,
      },
    ],
    finishedWeightSpec: {
      range: "17.55 - 18.05",
      unit: "oz",
      source: "Aldo's Pizza Specs.xlsx · OZ row 8",
    },
  },
});

test("derives ingredient tolerances and finished weight bounds from the saved run snapshot", () => {
  const before = snapshot();
  const expected = structuredClone(before);
  const result = buildRunQualityTargets(before);
  const byId = new Map(result.checks.map((check) => [check.id, check]));

  assert.equal(result.unavailableReason, null);
  assert.deepEqual(
    [byId.get("ingredient:sauce-row").targetOz, byId.get("ingredient:sauce-row").toleranceOz,
      byId.get("ingredient:sauce-row").minimumOz, byId.get("ingredient:sauce-row").maximumOz],
    [4, 0.05, 3.95, 4.05],
  );
  assert.deepEqual(
    [byId.get("ingredient:pep-row").targetOz, byId.get("ingredient:pep-row").toleranceOz,
      byId.get("ingredient:pep-row").minimumOz, byId.get("ingredient:pep-row").maximumOz],
    [1.1, 0.05, 1.05, 1.15],
  );
  assert.equal(byId.get("ingredient:cheese-row").toleranceOz, 0.1);
  assert.equal(byId.get("ingredient:pound-row").targetOz, 4);
  assert.equal(byId.get("ingredient:count-row").status, "unresolved");
  assert.equal(byId.get("ingredient:unresolved-row").status, "unresolved");
  assert.deepEqual(
    [byId.get("finished-pizza-weight").minimumOz, byId.get("finished-pizza-weight").maximumOz],
    [17.55, 18.05],
  );
  assert.deepEqual(before, expected, "target generation does not mutate the captured run snapshot");
});

test("does not invent a finished-weight target for an unclear or unlabelled source range", () => {
  const invalid = snapshot();
  invalid.runRequirements.finishedWeightSpec.range = "about 18 oz";
  const noUnit = snapshot();
  noUnit.runRequirements.finishedWeightSpec.unit = null;
  const oversized = snapshot();
  oversized.runRequirements.items[0].perPizza = 10001;
  const noPlan = buildRunQualityTargets({});

  assert.equal(buildRunQualityTargets(invalid).checks.at(-1).status, "unresolved");
  assert.match(buildRunQualityTargets(noUnit).checks.at(-1).unavailableReason, /unit/i);
  assert.match(buildRunQualityTargets(oversized).checks[0].unavailableReason, /scale range/i);
  assert.deepEqual(noPlan, {
    checks: [],
    unavailableReason: "This run has no saved requirements plan.",
  });
});
