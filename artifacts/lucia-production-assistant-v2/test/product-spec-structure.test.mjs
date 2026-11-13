import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultProductSpecRoleOverrides,
  parsePreservedProductSpec,
  parseProductSpecData,
  productSpecRoleKey,
} from "../src/importing/product-spec.ts";
import { parseProductSpecProfiles } from "../src/importing/workbook.ts";
import { customerProductSpecFixtures } from "./fixtures/product-spec-role-workbooks.mjs";

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
  assert.equal(cheeseData.sections[0].unit, "oz", "the OZ worksheet tab explicitly supplies the weight unit");
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

test("preserves row roles and worksheet coordinates for applicators across brands", () => {
  for (const brand of ["Lucia", "Aldo's"]) {
    const source = workbook([
      [brand, "Special"],
      ["Sauce", 2],
      ["PEP Applicator", 1.25],
      ["Cheese Applicator", 3],
      ["Pepperoni", 0.5],
      ["Mozzarella", 4],
      ["TARGET WEIGHT", 11],
      ["WEIGHT SPEC RANGE", "10.75 - 11.25"],
    ]);
    const profile = parseProductSpecProfiles(source).find((item) => item.brand === brand);
    assert.ok(profile);
    const ingredients = parseProductSpecData(source, profile).sections[0].ingredients;
    assert.deepEqual(ingredients.map((item) => item.ingredientRole), [
      "sauce",
      "pep_applicator",
      "cheese_applicator",
      "ingredient",
      "ingredient",
    ]);
    assert.deepEqual(ingredients[1].sourceCoordinates, {
      sheet: "OZ",
      row: 3,
      nameColumn: "A",
    });
  }
});

test("maps source labels from customer spec workbooks to roles with original coordinates", () => {
  for (const fixture of customerProductSpecFixtures) {
    const rowsByNumber = new Map(fixture.rows.map(({ row, cells }) => [row, cells]));
    const maxRow = Math.max(...rowsByNumber.keys());
    const rows = Array.from({ length: maxRow }, (_, index) => rowsByNumber.get(index + 1) ?? []);
    const source = {
      fileName: fixture.sourceWorkbook,
      sizeBytes: 1,
      sheetCount: 1,
      cellCount: fixture.rows.reduce(
        (count, { cells }) => count + cells.filter((cell) => cell != null && cell !== "").length,
        0,
      ),
      kind: "product_specs",
      kindConfidence: "high",
      sheets: [{ name: fixture.sheet, rows }],
    };
    const profile = parseProductSpecProfiles(source).find(
      (item) => item.brand === fixture.brand && item.flavor === fixture.flavor,
    );
    assert.ok(profile, `${fixture.sourceWorkbook} should retain its customer product section`);
    const section = parseProductSpecData(source, profile).sections[0];
    const ingredients = section.ingredients;
    assert.equal(section.targetWeight, fixture.targetWeight, `${fixture.sourceWorkbook} target weight`);
    assert.equal(section.weightSpecRange, fixture.weightSpecRange, `${fixture.sourceWorkbook} weight range`);

    assert.deepEqual(
      ingredients.map(({ sourceRow, name, ingredientRole, sourceCoordinates }) => ({
        row: sourceRow,
        name,
        sourceLabel: source.sheets[0].rows[sourceRow - 1][0],
        role: ingredientRole,
        sourceCoordinates,
      })),
      fixture.expectedRows.map(({ row, name, role }) => ({
        row,
        name: name.normalize("NFKC").trim().replace(/\s+/g, " "),
        sourceLabel: name,
        role,
        sourceCoordinates: {
          sheet: fixture.sheet,
          row,
          nameColumn: "A",
        },
      })),
      `${fixture.sourceWorkbook} row roles must remain tied to their source labels and coordinates`,
    );
  }
});

test("flags unfamiliar applicator labels with source sheet and row while keeping ordinary role", () => {
  const source = workbook([
    ["Sample Brand", "Special"],
    ["Pep Applicator - New Model", 1.25],
    ["Cheese applicators (alternate)", 1],
    ["Pep Applicator", 1],
    ["TARGET WEIGHT", 12],
    ["WEIGHT SPEC RANGE", "11.75 - 12.25"],
  ]);
  const profile = parseProductSpecProfiles(source)[0];
  const section = parseProductSpecData(source, profile).sections[0];

  assert.equal(section.ingredients[0].ingredientRole, "ingredient");
  assert.deepEqual(section.ingredients[0].sourceCoordinates, {
    sheet: "OZ",
    row: 2,
    nameColumn: "A",
  });
  assert.match(section.warnings[0], /OZ row 2.*Pep Applicator - New Model.*Confirm its role/);
  assert.equal(section.ingredients[1].ingredientRole, "ingredient");
  assert.match(section.warnings[1], /OZ row 3.*Cheese applicators.*Confirm its role/);
  assert.equal(section.ingredients[2].ingredientRole, "pep_applicator");
  assert.equal(section.warnings.length, 2);
});

test("defaults unfamiliar applicator rows to confirmed ordinary ingredient", () => {
  const source = workbook([
    ["Sample Brand", "Special"],
    ["Applicator - Unmapped model", 0.5],
    ["Pep Applicator", 0.25],
    ["TARGET WEIGHT", 12],
    ["WEIGHT SPEC RANGE", "11.75 - 12.25"],
  ]);
  const profile = parseProductSpecProfiles(source)[0];
  const extracted = parseProductSpecData(source, profile);
  const roleOverrides = defaultProductSpecRoleOverrides(extracted);
  const key = productSpecRoleKey(extracted.sections[0].ingredients[0].sourceCoordinates);
  const reviewed = parseProductSpecData(source, profile, roleOverrides);

  assert.deepEqual(roleOverrides, { [key]: "ingredient" });
  assert.equal(reviewed.sections[0].ingredients[0].ingredientRole, "ingredient");
  assert.equal(reviewed.sections[0].ingredients[0].roleConfirmed, true);
  assert.equal(reviewed.sections[0].warnings.some((warning) => /unrecognized applicator/i.test(warning)), false);
  assert.equal(roleOverrides[productSpecRoleKey(extracted.sections[0].ingredients[1].sourceCoordinates)], undefined);
});

test("confirmed applicator roles persist with their exact source coordinates", () => {
  const source = workbook([
    ["Sample Brand", "Special"],
    ["Sauce", 2],
    ["Applicator - New Model", 0.5],
    ["TARGET WEIGHT", 12],
    ["WEIGHT SPEC RANGE", "11.75 - 12.25"],
  ]);
  const profile = parseProductSpecProfiles(source)[0];
  const unreviewed = parseProductSpecData(source, profile);
  const ingredient = unreviewed.sections[0].ingredients[1];
  assert.equal(ingredient.roleConfirmed, false);
  const key = productSpecRoleKey(ingredient.sourceCoordinates);
  const roleOverrides = { [key]: "pep_applicator" };
  const reviewed = parseProductSpecData(source, profile, roleOverrides);
  assert.equal(reviewed.sections[0].ingredients[1].ingredientRole, "pep_applicator");
  assert.equal(reviewed.sections[0].ingredients[1].roleConfirmed, true);
  assert.equal(reviewed.sections[0].warnings.some((warning) => /unrecognized applicator/i.test(warning)), false);

  const preserved = {
    format: "lucia.workbook.sparse.v1",
    selectedProduct: {
      brand: profile.brand,
      flavor: profile.flavor,
      sections: profile.sections.map(({ endColumn, ...section }) => section),
      roleOverrides,
    },
    sheets: source.sheets.map((sheet) => ({
      name: sheet.name,
      cells: sheet.rows.flatMap((row, r) => row.flatMap((value, c) =>
        value == null ? [] : [{ r, c, v: value }],
      )),
    })),
  };
  const restored = parsePreservedProductSpec(preserved);
  assert.equal(restored.sections[0].ingredients[1].ingredientRole, "pep_applicator");
  assert.equal(restored.sections[0].ingredients[1].roleConfirmed, true);
});

test("keeps adjacent packaging tables out of ingredient amounts and product boundaries", () => {
  const source = workbook([
    ["Sample Pizzas", "MR12CH14", null, "Shipping notes", "CODE12"],
    ["Crust", 13, null, "Shipping Box", '12" shipper'],
    ["Sauce", 3, null, "Cases per pallet", 54],
    ["TARGET WEIGHT", 16],
    ["WEIGHT SPEC RANGE", "15.75 - 16.25"],
  ]);
  const profiles = parseProductSpecProfiles(source);
  assert.equal(profiles.length, 1);
  const data = parseProductSpecData(source, profiles[0]);
  assert.equal(data.sections[0].targetWeight, "16");
  assert.deepEqual(data.sections[0].ingredients[0].amounts, [
    { column: "B", value: "13" },
  ]);
});

test("reads older preserved spec sections without changing their saved source", () => {
  const source = workbook([
    ["Sample Pizzas", "Cheese"],
    ["Crust", 8],
    ["Cheese", 4],
    ["TARGET WEIGHT", 12],
    ["WEIGHT SPEC RANGE", "11.75 - 12.25"],
  ]);
  const profile = parseProductSpecProfiles(source)[0];
  const preserved = {
    format: "lucia.workbook.sparse.v1",
    selectedProduct: {
      brand: "Renamed brand",
      flavor: "Renamed flavor",
      sections: profile.sections.map(({ endColumn, ...section }) => section),
    },
    sheets: source.sheets.map((sheet) => ({
      name: sheet.name,
      cells: sheet.rows.flatMap((row, r) => row.flatMap((v, c) =>
        v == null ? [] : [{ r, c, v }],
      )),
    })),
  };
  const before = JSON.stringify(preserved);
  const data = parsePreservedProductSpec(preserved);
  assert.ok(data);
  assert.equal(data.brand, "Renamed brand");
  assert.equal(data.flavor, "Renamed flavor");
  assert.equal(data.sections[0].targetWeight, "12");
  assert.equal(data.sections[0].ingredients.length, 2);
  assert.equal(JSON.stringify(preserved), before);
});
