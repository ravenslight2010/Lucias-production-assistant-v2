import test from "node:test";
import assert from "node:assert/strict";
import { parseProductSpecData } from "../src/importing/product-spec.ts";
import { parseProductSpecProfiles } from "../src/importing/workbook.ts";

const workbook = (rows) => ({
  fileName: "customer-pizza-specs.xlsx",
  sizeBytes: 1,
  sheetCount: 1,
  cellCount: rows.flat().filter((cell) => cell != null && cell !== "").length,
  kind: "product_specs",
  kindConfidence: "high",
  sheets: [{ name: "OZ", rows }],
});

test("extracts product weights and formula rows without mixing side-by-side products", () => {
  const source = workbook([
    [null, null, null, "Sample Brand", '12" Sausage'],
    [null, "SOY ALLERGEN", null, null, "OZ"],
    ["Sample Brand", '9" Cheese', null, null, null],
    ["Parbake Crust", 3.25, null, "Parbake Crust", 7.25],
    ["Pizza Sauce", 2.25, null, "Pizza Sauce", 4],
    ["TARGET WEIGHT", 8.5, null, "TARGET WEIGHT", 19.25],
    ["WEIGHT SPEC RANGE", "8.25 - 8.75", null, "WEIGHT SPEC RANGE", "19.00 - 19.50"],
  ]);
  const profiles = parseProductSpecProfiles(source);

  assert.equal(profiles.length, 2);
  const cheese = profiles.find((profile) => profile.flavor === '9" Cheese');
  const sausage = profiles.find((profile) => profile.flavor === '12" Sausage');
  assert.ok(cheese && sausage);

  const cheeseData = parseProductSpecData(source, cheese);
  assert.equal(cheeseData.sections[0].targetWeight, "8.5");
  assert.equal(cheeseData.sections[0].weightSpecRange, "8.25 - 8.75");
  assert.deepEqual(cheeseData.sections[0].ingredients.map((ingredient) => ingredient.name), [
    "Parbake Crust",
    "Pizza Sauce",
  ]);
  assert.deepEqual(cheeseData.sections[0].ingredients[0].amounts, [
    { column: "B", value: "3.25" },
  ]);
  assert.deepEqual(cheeseData.sections[0].notes, ["SOY ALLERGEN"]);

  const sausageData = parseProductSpecData(source, sausage);
  assert.equal(sausageData.sections[0].targetWeight, "19.25");
  assert.equal(sausageData.sections[0].weightSpecRange, "19.00 - 19.50");
  assert.equal(sausageData.sections[0].unit, "oz");
  assert.deepEqual(sausageData.sections[0].ingredients.map((ingredient) => ingredient.name), [
    "Parbake Crust",
    "Pizza Sauce",
  ]);
  assert.deepEqual(sausageData.sections[0].ingredients[0].amounts, [
    { column: "E", value: "7.25" },
  ]);
});

test("does not let an incomplete product section borrow the next section's target weight", () => {
  const source = workbook([
    ["Sample Brand", "Incomplete"],
    ["Crust", 1],
    ["Sample Brand", "Complete"],
    ["Crust", 2],
    ["TARGET WEIGHT", 3],
    ["WEIGHT SPEC RANGE", "2.5 - 3.5"],
  ]);

  const profiles = parseProductSpecProfiles(source);
  assert.deepEqual(profiles.map((profile) => profile.flavor), ["Complete"]);
  const data = parseProductSpecData(source, profiles[0]);
  assert.equal(data.sections[0].targetWeight, "3");
  assert.equal(data.sections[0].weightSpecRange, "2.5 - 3.5");
});
