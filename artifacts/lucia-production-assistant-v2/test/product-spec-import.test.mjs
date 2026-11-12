import test from "node:test";
import assert from "node:assert/strict";
import { detectImportKind, parseProductSpecProfiles } from "../src/importing/workbook.ts";

const sheet = (name, rows) => ({ name, rows });
const workbook = (sheets) => ({
  fileName: "customer-specs.xlsx",
  sizeBytes: 1,
  sheetCount: sheets.length,
  cellCount: sheets.reduce((sum, item) => sum + item.rows.flat().filter((cell) => cell != null && cell !== "").length, 0),
  kind: "product_specs",
  kindConfidence: "high",
  sheets,
});

test("splits side-by-side product sections and excludes ingredient quantity rows", () => {
  const parsed = parseProductSpecProfiles(workbook([
    sheet("OZ", [
      ["Lucia's", "6 Cheese", null, "Lucia's", "Pepperoni"],
      ["Parbake crust", 7.5, null, "Parbake crust", 7.5],
      ["Applicator - cheese mix", 4, null, "Pepperoni Stick", "13 = 1.10"],
      ["TARGET WEIGHT", 19.5, null, "TARGET WEIGHT", 20],
      ["WEIGHT SPEC RANGE", "19.25 - 19.75", null, "WEIGHT SPEC RANGE", "19.75 - 20.25"],
    ]),
  ]));

  assert.deepEqual(parsed.map(({ brand, flavor }) => [brand, flavor]), [
    ["Lucia's", "6 Cheese"],
    ["Lucia's", "Pepperoni"],
  ]);
  assert.equal(parsed[0].sections[0].headerRow, 1);
  assert.equal(parsed[0].sections[0].endRow, 5);
});

test("recognizes customer pizza-spec workbooks by filename and product-specific fields", () => {
  const productSheets = [
    sheet("OZ", [
      ["Lucia's", "6 Cheese"],
      ["Applicator - cheese mix", 4],
      ["TARGET WEIGHT", 19.5],
      ["WEIGHT SPEC RANGE", "19.25 - 19.75"],
    ]),
  ];
  assert.deepEqual(detectImportKind(productSheets, "Lucia_Pizza_Recipe_Specs.xlsx"), {
    kind: "product_specs",
    confidence: "high",
  });
  assert.deepEqual(detectImportKind(productSheets, "New_Lucias_Pizzas.xlsx"), {
    kind: "product_specs",
    confidence: "high",
  });
  assert.deepEqual(detectImportKind([sheet("Sheet1", [["CRB DOUGH"]])], "CRB_Dough_Mixing_Procedure.xlsx"), {
    kind: "dough_guide",
    confidence: "high",
  });
  assert.deepEqual(detectImportKind([sheet("Sheet1", [["Tika Masala Sauce"]])], "Tikka_Masala_Process.xlsx"), {
    kind: "sauce_guide",
    confidence: "high",
  });
  assert.deepEqual(detectImportKind([sheet("Sheet1", [["Ingredients"]])], "Updated_Pre_Mix_Sheets.xlsx"), {
    kind: "premix",
    confidence: "high",
  });
  assert.deepEqual(detectImportKind(
    [sheet("Sheet1", [["Malted Barley"], ["Ingredients:"], ["Process"]])],
    "Malted_Barley_Process.xlsx",
  ), {
    kind: null,
    confidence: "review",
  });
});

test("groups repeated brand/flavor sections across sheets and ignores incomplete headings", () => {
  const parsed = parseProductSpecProfiles(workbook([
    sheet("First", [
      ["On 11\" sauce head, place pins in outer 4 rows for 7\" pizza", "02/26/2026 Revision 6"],
      ["Lucia's", null, "Six Cheese"],
      ["Crust", 7.5, null],
      ["TARGET WEIGHT", 19.5, null],
      ["WEIGHT SPEC RANGE", "19.25 - 19.75", null],
      ["Bobo's", "Cheese"],
      ["Crust", 7.5],
    ]),
    sheet("Second", [
      ["Lucia's", "Six Cheese"],
      ["Cheese mix", 4],
      ["TARGET WEIGHT", 19.5],
      ["WEIGHT SPEC RANGE", "19.25 - 19.75"],
    ]),
  ]));

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].brand, "Lucia's");
  assert.equal(parsed[0].flavor, "Six Cheese");
  assert.equal(parsed[0].sections.length, 2);
  assert.deepEqual(parsed[0].sections.map(({ sheet: source }) => source), ["First", "Second"]);
});
