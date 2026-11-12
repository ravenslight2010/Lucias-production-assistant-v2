import test from "node:test";
import assert from "node:assert/strict";
import {
  filterShippingWorkbookByBrand,
  normalizeShippingBrand,
  parseOperationalWorkbook,
  shippingRowCountForBrand,
} from "../src/importing/operational.ts";

const sheet = (name, rows) => ({ name, rows });
const workbook = (kind, sheets) => ({
  fileName: "operations.xlsx",
  sizeBytes: 1,
  sheetCount: sheets.length,
  cellCount: sheets.reduce((sum, item) => sum + item.rows.flat().filter((cell) => cell != null && cell !== "").length, 0),
  kind,
  kindConfidence: "high",
  sheets,
});

test("extracts dough ingredients, batch amounts, process steps, and product mappings", () => {
  const parsed = parseOperationalWorkbook(workbook("dough_guide", [
    sheet("Dough", [
      ["Sample Dough Recipe"],
      ["Sample Brand: all pizza flavors"],
      ["Ingredients"],
      ["", "Ingredient", "LBS", "2x batch"],
      ["", "Flour", 20, 40],
      ["", "Water", 12, 24],
      ["", "Total", 32, 64],
      ["Materials"],
      ["Mixer"],
      ["Step 1: Add ingredients"],
      ["2) Mix until smooth"],
    ]),
  ]), "dough_guide");

  const recipe = parsed.sheets[0].recipes[0];
  assert.equal(recipe.ingredients.length, 2);
  assert.deepEqual(recipe.ingredients[0].amounts.map(({ value }) => value), [20, 40]);
  assert.deepEqual(recipe.steps.map(({ text }) => text), ["Add ingredients", "Mix until smooth"]);
  assert.deepEqual(recipe.equipment, ["Mixer"]);
  assert.equal(parsed.sheets[0].productMappings[0].recipe, "all pizza flavors");
});

test("extracts premix recipes, totals, batch metrics, and pull quantities", () => {
  const parsed = parseOperationalWorkbook(workbook("premix", [
    sheet("Customer", [
      ["Sample Premix"],
      ["Ingredient", "Per Pizza (oz)", "Per Batch (lbs)"],
      ["Flour", 0.15, 12],
      ["Salt", 0.01, 1],
      ["Total", 0.16, 13],
      ["Mixes", 2],
      ["Cases needed", 4],
      ["PULL FOR MIX"],
      ["Flour", 12],
      ["Salt", 1],
    ]),
  ]), "premix");

  const recipe = parsed.sheets[0].recipes[0];
  assert.equal(parsed.title, "Sample Premix");
  assert.equal(recipe.name, "Sample Premix");
  assert.equal(recipe.ingredients.length, 2);
  assert.equal(recipe.total?.amounts[1].value, 13);
  assert.ok(recipe.metrics.some(({ name }) => name === "Mixes"));
  assert.ok(recipe.metrics.some(({ name }) => name === "Pull: Flour"));
});

test("extracts each cheese formula and keeps its source mapping", () => {
  const parsed = parseOperationalWorkbook(workbook("cheese", [
    sheet("Retail", [
      ["Applies: Customer pizza"],
      ["", "Sample Cheese Mix"],
      ["", "Ingredient", "LBS"],
      ["", "Mozzarella", 20],
      ["", "Spice Blend", 2],
      ["", "Total", 22],
    ]),
  ]), "cheese");

  assert.equal(parsed.sheets[0].recipes.length, 1);
  assert.equal(parsed.sheets[0].recipes[0].ingredients.length, 2);
  assert.equal(parsed.sheets[0].recipes[0].total?.amounts[0].value, 22);
  assert.equal(parsed.sheets[0].productMappings.length, 1);
});

test("retains shipping specifications as structured brand rows", () => {
  const parsed = parseOperationalWorkbook(workbook("shipping", [
    sheet("Palletizing", [
      ["PIZZA", "BOX", "DIMENSIONS", "PALLET TYPE", "STACKING"],
      ["Sample Brand", "6-pack", "14 x 14", "Standard", "8 cases"],
    ]),
  ]), "shipping");

  assert.equal(parsed.sheets[0].shippingRecords.length, 1);
  assert.equal(parsed.sheets[0].shippingRecords[0].brand, "Sample Brand");
  assert.equal(parsed.sheets[0].shippingRecords[0].values.BOX, "6-pack");
});

test("shipping references can be safely scoped to every flavor of a normalized brand", () => {
  const parsed = parseOperationalWorkbook(workbook("shipping", [
    sheet("Palletizing", [
      ["PIZZA", "BOX", "PALLET TYPE"],
      ["Lucia’s", "12-pack", "Standard"],
      [" LUCIA'S  ", "6-pack", "Standard"],
      ["Other Brand", "6-pack", "Standard"],
    ]),
  ]), "shipping");
  const filtered = filterShippingWorkbookByBrand(parsed, "Lucia's");
  assert.equal(filtered.filteredToBrand, "Lucia's");
  assert.equal(filtered.sheets[0].shippingRecords.length, 2);
  assert.equal(shippingRowCountForBrand(parsed, " LUCIA'S "), 2);
  assert.equal(normalizeShippingBrand("  Lucia’s   Pizza "), "lucia's pizza");
  assert.equal(shippingRowCountForBrand(parsed, "Other Brand"), 1);
  assert.throws(() => filterShippingWorkbookByBrand(parsed, "Missing Brand"), /No shipping rows match/);
});

test("only extracts selected worksheets and preserves their selection", () => {
  const parsed = parseOperationalWorkbook(workbook("sauce_guide", [
    sheet("Sauce A", [["A Sauce"], ["Ingredients:"], ["Ingredient", "LBS"], ["Tomato", 15], ["Total", 15]]),
    sheet("Sauce B", [["B Sauce"], ["Ingredients:"], ["Ingredient", "LBS"], ["Tomato", 20], ["Total", 20]]),
  ]), "sauce_guide", ["Sauce B"]);

  assert.deepEqual(parsed.selectedSheetNames, ["Sauce B"]);
  assert.equal(parsed.sheets.length, 1);
  assert.equal(parsed.sheets[0].recipes[0].ingredients[0].amounts[0].value, 20);
});

test("flags a process-only sauce sheet instead of silently presenting it as complete", () => {
  const parsed = parseOperationalWorkbook(workbook("sauce_guide", [
    sheet("Sauce", [["Sauce instructions"], ["Process"], ["1. Blend ingredients"], ["2. Heat to temperature"]]),
  ]), "sauce_guide");

  assert.equal(parsed.sheets[0].recipes.length, 1);
  assert.ok(parsed.warnings.some((warning) => warning.includes("No ingredient table")));
});

test("extracts recipe amounts even when a workbook places the quantity column before the ingredient", () => {
  const parsed = parseOperationalWorkbook(workbook("sauce_guide", [
    sheet("Sauce", [
      ["Sample Sauce"],
      ["Ingredients"],
      ["LBS", "Ingredient"],
      [10, "Tomato"],
      [2, "Salt"],
      [12, "Total"],
      ["Process"],
      ["1. Combine ingredients"],
    ]),
  ]), "sauce_guide");

  assert.equal(parsed.sheets[0].recipes[0].ingredients.length, 2);
  assert.equal(parsed.sheets[0].recipes[0].ingredients[0].name, "Tomato");
  assert.equal(parsed.sheets[0].recipes[0].ingredients[0].amounts[0].label, "LBS");
  assert.equal(parsed.sheets[0].recipes[0].ingredients[0].amounts[0].value, 10);
  assert.equal(parsed.warnings.length, 0);
});
