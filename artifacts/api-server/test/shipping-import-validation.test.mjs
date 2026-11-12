import test from "node:test";
import assert from "node:assert/strict";
import { shippingDataMatchesBrand } from "../src/lib/shipping-import-validation.ts";

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
