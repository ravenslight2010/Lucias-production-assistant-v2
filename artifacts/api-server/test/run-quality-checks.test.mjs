import assert from "node:assert/strict";
import { after, default as test } from "node:test";
import { build as esbuild } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PreviewRunRequirementsResponse } from "../../../lib/api-zod/src/generated/api.ts";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const bundleDirectory = await mkdtemp(
  path.join(testDirectory, "../../../lib/db/tests/.run-quality-checks-"),
);
await esbuild({
  entryPoints: [
    path.resolve(testDirectory, "../src/lib/run-requirements.ts"),
    path.resolve(testDirectory, "../src/lib/run-quality-checks.ts"),
  ],
  outdir: bundleDirectory,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "bundle",
  external: ["pg"],
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
after(() => rm(bundleDirectory, { recursive: true, force: true }));
const { buildRunRequirements } = await import(
  pathToFileURL(path.join(bundleDirectory, "run-requirements.mjs")).href
);
const { buildRunQualityTargets } = await import(
  pathToFileURL(path.join(bundleDirectory, "run-quality-checks.mjs")).href
);

const snapshot = () => ({
  runRequirements: {
    items: [
      {
        id: "sauce-row",
        name: "Aldo's Sauce",
        originalName: "Aldo's Sauce (made in house)",
        source: "Aldo's Pizza Specs.xlsx · OZ row 4",
        ingredientRole: "sauce",
        sourceCoordinates: { sheet: "OZ", row: 4, nameColumn: "A" },
        station: "Production line",
        usageUnit: "oz",
        perPizza: 4,
      },
      {
        id: "pep-row",
        name: "Pepperoni Stick",
        originalName: "Pepperoni Stick (Cured)",
        source: "Aldo's Pizza Specs.xlsx · OZ row 16",
        ingredientRole: "pep_applicator",
        sourceCoordinates: { sheet: "OZ", row: 16, nameColumn: "A" },
        station: "Production line",
        usageUnit: "oz",
        perPizza: 1.1,
      },
      {
        id: "cheese-row",
        name: "Cheese mix",
        originalName: "Applicator - Aldo's Cheese Mix",
        source: "Aldo's Pizza Specs.xlsx · OZ row 5",
        ingredientRole: "cheese_applicator",
        sourceCoordinates: { sheet: "OZ", row: 5, nameColumn: "A" },
        station: "Production line",
        usageUnit: "oz",
        perPizza: 3.5,
      },
      {
        id: "pound-row",
        name: "Flour",
        originalName: "Flour",
        source: "Test spec.xlsx · row 20",
        ingredientRole: "ingredient",
        sourceCoordinates: { sheet: "OZ", row: 20, nameColumn: "A" },
        station: "Production line",
        usageUnit: "lb",
        perPizza: 0.25,
      },
      {
        id: "count-row",
        name: "Whole olives",
        originalName: "Whole olives",
        source: "Test spec.xlsx · row 21",
        ingredientRole: "ingredient",
        sourceCoordinates: { sheet: "OZ", row: 21, nameColumn: "A" },
        station: "Production line",
        usageUnit: "each",
        perPizza: 2,
      },
      {
        id: "unresolved-row",
        name: "Annotated pepperoni amount",
        originalName: "Pepperoni Stick",
        source: "Test spec.xlsx · row 22",
        ingredientRole: "ingredient",
        sourceCoordinates: { sheet: "OZ", row: 22, nameColumn: "A" },
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
  assert.equal(byId.get("ingredient:pound-row").toleranceOz, 0.1);
  assert.equal(byId.get("ingredient:pound-row").targetOz, 4);
  assert.equal(byId.get("ingredient:count-row").status, "unresolved");
  assert.equal(byId.get("ingredient:unresolved-row").status, "unresolved");
  assert.deepEqual(
    [byId.get("finished-pizza-weight").minimumOz, byId.get("finished-pizza-weight").maximumOz],
    [17.55, 18.05],
  );
  assert.deepEqual(before, expected, "target generation does not mutate the captured run snapshot");
});

test("uses captured row role rather than ingredient names when assigning tolerances", () => {
  const captured = {
    runRequirements: {
      items: [
        { id: "named-sauce", name: "Sauce", originalName: "Sauce", ingredientRole: "ingredient", usageUnit: "oz", perPizza: 2 },
        { id: "named-pep", name: "Pepperoni", originalName: "Pepperoni", ingredientRole: "ingredient", usageUnit: "oz", perPizza: 1 },
        { id: "legacy-pep", name: "Pepperoni", originalName: "Pepperoni", usageUnit: "oz", perPizza: 1 },
        { id: "sauce-row", name: "Tomato blend", ingredientRole: "sauce", usageUnit: "oz", perPizza: 2 },
        { id: "pep-row", name: "Topping blend", ingredientRole: "pep_applicator", usageUnit: "oz", perPizza: 1 },
        { id: "cheese-row", name: "Cheese Applicator", ingredientRole: "cheese_applicator", usageUnit: "oz", perPizza: 3 },
      ],
      finishedWeightSpec: { range: "10 - 12", unit: "oz", source: "Specs" },
    },
  };
  const byId = new Map(buildRunQualityTargets(captured).checks.map((check) => [check.id, check]));
  assert.equal(byId.get("ingredient:named-sauce").toleranceOz, 0.1);
  assert.equal(byId.get("ingredient:named-pep").toleranceOz, 0.1);
  assert.equal(byId.get("ingredient:legacy-pep").toleranceOz, 0.1);
  assert.equal(byId.get("ingredient:sauce-row").toleranceOz, 0.05);
  assert.equal(byId.get("ingredient:pep-row").toleranceOz, 0.05);
  assert.equal(byId.get("ingredient:cheese-row").toleranceOz, 0.1);
});

test("copies imported row role and coordinates into the saved requirements plan", () => {
  const profile = {
    brand: "Lucia",
    flavor: "Cheese",
    revision: 0,
    productData: {
      sources: [{
        brand: "Lucia",
        sourceName: "spec.xlsx",
        content: {
          format: "lucia.product-spec.v1",
          sections: [{
            sheet: "OZ",
            headerRow: 1,
            unit: "oz",
            notes: [],
            warnings: [],
            ingredients: [{
              sourceRow: 5,
              sourceCoordinates: { sheet: "OZ", row: 5, nameColumn: "A" },
              ingredientRole: "pep_applicator",
              name: "Pizza Topping",
              amounts: [{ column: "B", value: "1.25" }],
            }],
          }],
        },
      }],
    },
  };
  const plan = buildRunRequirements(profile, 1, { unitsPerCase: 12, links: [] });
  const item = plan.items[0];
  const resolvedPlan = buildRunRequirements(profile, 1, {
    unitsPerCase: 12,
    sectionId: plan.sectionId,
    links: [{ itemId: item.id, directIngredient: true }],
  });

  assert.deepEqual(
    [resolvedPlan.items[0].ingredientRole, resolvedPlan.items[0].sourceCoordinates],
    ["pep_applicator", { sheet: "OZ", row: 5, nameColumn: "A" }],
  );
  assert.doesNotThrow(() => PreviewRunRequirementsResponse.parse(resolvedPlan));
});

test("captures each early-pull instruction as a stable, source-traceable run item", () => {
  const profile = {
    brand: "Lucia",
    flavor: "Sauce",
    revision: 2,
    productData: {
      sources: [{
        brand: "Lucia",
        sourceName: "Updated Pre-Mix Sheets.xlsx",
        content: {
          format: "lucia.operational-workbook.v1",
          importKind: "premix",
          sheets: [{
            name: "Premix Pulls",
            recipes: [{
              name: "Lucia Pizza Sauce premix",
              premix: {
                pullInstructions: [
                  { text: "Move from freezer to cooler", sourceRow: 14, sourceColumn: "B", daysEarly: 2 },
                  { text: "Prepare only after thawing", sourceRow: 15, sourceColumn: "C" },
                ],
              },
            }],
          }],
        },
      }],
    },
  };
  const first = buildRunRequirements(profile, 24, { unitsPerCase: 12 });
  const second = buildRunRequirements(profile, 24, { unitsPerCase: 12 });

  assert.equal(first.preparationItems.length, 2);
  assert.deepEqual(first.preparationItems, second.preparationItems);
  assert.deepEqual(first.preparationItems.map((item) => ({
    name: item.name,
    instruction: item.instruction,
    source: item.source,
    sourceRow: item.sourceRow,
    sourceColumn: item.sourceColumn,
    daysEarly: item.daysEarly,
  })), [
    {
      name: "Lucia Pizza Sauce premix",
      instruction: "Move from freezer to cooler",
      source: "Updated Pre-Mix Sheets.xlsx · Premix Pulls · Lucia Pizza Sauce premix · row 14",
      sourceRow: 14,
      sourceColumn: "B",
      daysEarly: 2,
    },
    {
      name: "Lucia Pizza Sauce premix",
      instruction: "Prepare only after thawing",
      source: "Updated Pre-Mix Sheets.xlsx · Premix Pulls · Lucia Pizza Sauce premix · row 15",
      sourceRow: 15,
      sourceColumn: "C",
      daysEarly: null,
    },
  ]);
  assert.doesNotThrow(() => PreviewRunRequirementsResponse.parse(first));
});

test("unknown applicator variants remain unresolved until source-role review", () => {
  const profile = {
    brand: "Lucia",
    flavor: "Cheese",
    revision: 0,
    productData: {
      sources: [{
        sourceName: "customer-spec.xlsx",
        content: {
          format: "lucia.product-spec.v1",
          sections: [{
            sheet: "OZ",
            headerRow: 1,
            unit: "oz",
            notes: [],
            warnings: [],
            ingredients: [{
              sourceRow: 7,
              sourceCoordinates: { sheet: "OZ", row: 7, nameColumn: "A" },
              ingredientRole: "pep_applicator",
              name: "Pep Applicator - New Model",
              amounts: [{ column: "B", value: "1.25" }],
            }],
          }],
        },
      }],
    },
  };
  const initialPlan = buildRunRequirements(profile, 1, { unitsPerCase: 12 });
  const plan = buildRunRequirements(profile, 1, {
    unitsPerCase: 12,
    sectionId: initialPlan.sectionId,
    links: [{ itemId: initialPlan.items[0].id, directIngredient: true }],
  });
  const item = plan.items[0];

  assert.equal(item.ingredientRole, "ingredient", "unknown label cannot retain a tighter imported role");
  assert.equal(item.ingredientRoleConfirmed, false);
  assert.deepEqual(item.sourceCoordinates, { sheet: "OZ", row: 7, nameColumn: "A" });
  assert.ok(item.issues.some(issue => /OZ row 7.*Pep Applicator - New Model.*this requirement stays flagged/.test(issue)));
  assert.equal(plan.status, "needs_review");
  assert.doesNotThrow(() => PreviewRunRequirementsResponse.parse(plan));

  const quality = buildRunQualityTargets({
    runRequirements: {
      items: [{
        id: "legacy-unknown",
        originalName: "Pep Applicator - New Model",
        ingredientRole: "pep_applicator",
        usageUnit: "oz",
        perPizza: 1.25,
      }],
      finishedWeightSpec: { range: "11 - 13", unit: "oz", source: "customer-spec.xlsx · OZ row 9" },
    },
  });
  assert.equal(quality.checks[0].status, "unresolved", "legacy unknown applicators cannot receive a guessed target");
  assert.match(quality.checks[0].unavailableReason, /confirm this applicator role/i);

  profile.productData.sources[0].content.sections[0].ingredients[0].roleConfirmed = true;
  const reviewedInitialPlan = buildRunRequirements(profile, 1, { unitsPerCase: 12 });
  const confirmedPlan = buildRunRequirements(profile, 1, {
    unitsPerCase: 12,
    sectionId: reviewedInitialPlan.sectionId,
    links: [{ itemId: reviewedInitialPlan.items[0].id, directIngredient: true }],
  });
  const confirmedItem = confirmedPlan.items[0];
  assert.equal(confirmedItem.ingredientRole, "pep_applicator");
  assert.equal(confirmedItem.ingredientRoleConfirmed, true);
  assert.equal(confirmedItem.issues.some(issue => /unrecognized applicator/i.test(issue)), false);
  const confirmedQuality = buildRunQualityTargets({
    runRequirements: {
      items: [confirmedItem],
      finishedWeightSpec: { range: "11 - 13", unit: "oz", source: "customer-spec.xlsx · OZ row 9" },
    },
  });
  assert.equal(confirmedQuality.checks[0].status, "ready");
  assert.equal(confirmedQuality.checks[0].toleranceOz, 0.05);

  profile.productData.sources[0].content.sections[0].ingredients[0].ingredientRole = "ingredient";
  const ordinaryInitialPlan = buildRunRequirements(profile, 1, { unitsPerCase: 12 });
  const ordinaryPlan = buildRunRequirements(profile, 1, {
    unitsPerCase: 12,
    sectionId: ordinaryInitialPlan.sectionId,
    links: [{ itemId: ordinaryInitialPlan.items[0].id, directIngredient: true }],
  });
  assert.equal(ordinaryPlan.items[0].ingredientRole, "ingredient");
  assert.equal(ordinaryPlan.items[0].ingredientRoleConfirmed, true);
  const ordinaryQuality = buildRunQualityTargets({
    runRequirements: {
      items: [ordinaryPlan.items[0]],
      finishedWeightSpec: { range: "11 - 13", unit: "oz", source: "customer-spec.xlsx · OZ row 9" },
    },
  });
  assert.equal(ordinaryQuality.checks[0].status, "ready");
  assert.equal(ordinaryQuality.checks[0].toleranceOz, 0.1);
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
