import test from "node:test";
import assert from "node:assert/strict";
import { shippingDataMatchesBrand, shippingSelectionIdentity } from "../src/lib/shipping-import-validation.ts";

const shippingData = (filteredToBrand, shippingRecords) => ({
  structured: {
    importKind: "shipping",
    filteredToBrand,
    sheets: [{ name: "Palletizing", shippingRecords }],
  },
});

test("accepts shipping rows for a matching normalized profile brand", () => {
  assert.equal(shippingDataMatchesBrand(shippingData("Lucia’s", [
    { brand: "LUCIA'S", sourceRow: 4 },
    { brand: " Lucia's ", sourceRow: 5 },
  ]), " Lucia's  "), true);
});

test("rejects shipping rows for another brand or an empty source", () => {
  assert.equal(shippingDataMatchesBrand(shippingData("Lucia's", [
    { brand: "Other Brand", sourceRow: 4 },
  ]), "Lucia's"), false);
  assert.equal(shippingDataMatchesBrand(shippingData("Lucia's", []), "Lucia's"), false);
  assert.equal(shippingDataMatchesBrand(shippingData("Other Brand", [
    { brand: "Other Brand", sourceRow: 4 },
  ]), "Lucia's"), false);
});

const selected = (row = 3) => ({
  structured: {
    importKind: "shipping", filteredToBrand: "Customer",
    shippingSelection: { format: "lucia.shipping-selection.v1", key: JSON.stringify(["Guide", row]), targetBrand: "Customer", targetFlavor: "Cheese", reviewed: true },
    sheets: [{ name: "Guide", shippingRecords: [{
      sourceRow: row, brand: "Original Carton Label", values: { BOX: "12 shipper" },
      shipping: { format: "lucia.shipping-details.v1", key: JSON.stringify(["Guide", row]), headerRow: 2,
        cells: [{ column: 1, label: "PIZZA", value: "Original Carton Label" }], issues: [],
        packsPerCase: 4, pizzasPerPack: 3, pizzasPerCase: 12, casesPerPallet: 48 },
    }] }],
  },
});

test("accepts explicit cross-label shipping variants with target identity, and distinguishes retries", () => {
  const data = selected();
  assert.equal(shippingDataMatchesBrand(data, "Customer", "Cheese"), true);
  assert.equal(shippingDataMatchesBrand(data, "Another", "Cheese"), false);
  assert.equal(shippingDataMatchesBrand(data, "Customer", "Pepperoni"), false);
  assert.equal(shippingSelectionIdentity(data, "Customer", "Cheese"), shippingSelectionIdentity(structuredClone(data), "Customer", "Cheese"));
  assert.notEqual(shippingSelectionIdentity(data, "Customer", "Cheese"), shippingSelectionIdentity(selected(4), "Customer", "Cheese"));
});

test("rejects unreviewed, multiple, mismatched or malformed packaging selections", () => {
  for (const mutate of [
    d => { d.structured.shippingSelection.reviewed = false; },
    d => { d.structured.sheets[0].shippingRecords.push(d.structured.sheets[0].shippingRecords[0]); },
    d => { d.structured.shippingSelection.key = '["Guide",100]'; },
    d => { d.structured.sheets[0].shippingRecords[0].shipping.pizzasPerCase = 13; },
    d => { d.structured.sheets[0].shippingRecords[0].shipping.headerRow = 3; },
    d => { d.structured.sheets[0].shippingRecords[0].shipping.cells[0].column = -1; },
  ]) {
    const data = selected(); mutate(data);
    assert.equal(shippingDataMatchesBrand(data, "Customer", "Cheese"), false);
    assert.throws(() => shippingSelectionIdentity(data, "Customer", "Cheese"));
  }
});
