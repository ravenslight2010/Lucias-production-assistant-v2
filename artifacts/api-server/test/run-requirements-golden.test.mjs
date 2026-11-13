import assert from "node:assert/strict";
import test from "node:test";
import { build as esbuild } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runMathGoldenProfile } from "./fixtures/run-math-golden.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const bundleDirectory = await mkdtemp(
  path.join(testDirectory, "../../../lib/db/tests/.run-math-golden-"),
);
await esbuild({
  entryPoints: [path.resolve(testDirectory, "../src/lib/run-requirements.ts")],
  outdir: bundleDirectory,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "bundle",
  external: ["pg"],
});
test.after(() => rm(bundleDirectory, { recursive: true, force: true }));
const {
  buildRunRequirements,
  calculateRunRequirementsProgress,
} = await import(pathToFileURL(path.join(bundleDirectory, "run-requirements.mjs")).href);

test("golden run math keeps dough, sauce, cheese, tray, batch, and live counts distinct", () => {
  const choices = { unitsPerCase: 12 };
  const initial = buildRunRequirements(runMathGoldenProfile, 10, choices);
  const recipeByName = new Map(initial.recipes.map((recipe) => [recipe.name, recipe]));
  const links = initial.items.map((item) => {
    if (item.originalName === "Tray") {
      return {
        itemId: item.id,
        recipeId: null,
        directIngredient: true,
        amountColumn: "B",
        usageUnit: "each",
      };
    }
    const recipe = recipeByName.get(item.originalName);
    assert.ok(recipe, `missing golden recipe for ${item.originalName}`);
    return { itemId: item.id, recipeId: recipe.id, batchColumn: 2 };
  });
  const plan = buildRunRequirements(runMathGoldenProfile, 10, {
    ...choices,
    sectionId: initial.sections[0].id,
    links,
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.totalPizzas, 120);
  assert.deepEqual(
    plan.items.map((item) => [item.originalName, item.totalRequired, item.usageUnit]),
    [
      ["Lucia Dough", 960, "oz"],
      ["Lucia Sauce", 240, "oz"],
      ["Lucia Cheese Mix", 360, "oz"],
      ["Tray", 120, "each"],
    ],
  );
  assert.deepEqual(
    plan.items.slice(0, 3).map((item) => [
      item.batchYield,
      item.batchesExact,
      item.wholeBatches,
      item.remainder,
      item.ingredients.map((ingredient) => [
        ingredient.name,
        ingredient.exactRequired,
        ingredient.wholeBatchRequired,
      ]),
    ]),
    [
      [200, 0.3, 1, 140, [["Flour", 48, 160], ["Water", 12, 40]]],
      [50, 0.3, 1, 35, [["Tomatoes", 12, 40], ["Water", 3, 10]]],
      [20, 1.125, 2, 17.5, [["Mozzarella", 13.5, 24], ["Cheese blend", 9, 16]]],
    ],
  );
  assert.equal(plan.batchPreparation.length, 3);
  assert.equal(plan.finishedWeightSpec?.range, "18.25 - 18.75");

  const progress = calculateRunRequirementsProgress(plan, [
    { area: "dough_prep", completedCases: 4, recorded: true },
    { area: "sauce_prep", completedCases: 4, recorded: true },
    { area: "production_line", completedCases: 7, recorded: true },
  ]);
  const trayProgress = progress.items.find((item) => item.id === plan.items[3].id);
  assert.equal(trayProgress?.remainingRequired, 36);
  assert.equal(trayProgress?.proposedUsage[0]?.proposedQuantity, 84);
  assert.equal(
    progress.items.find((item) => item.id === plan.batchPreparation[0].id)
      ?.proposedUsage[0]?.proposedQuantity,
    19.2,
  );
});
