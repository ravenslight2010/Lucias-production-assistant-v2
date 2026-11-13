import assert from "node:assert/strict";
import test from "node:test";
import { findInventoryShortages } from "../src/run-inventory-shortage.ts";

test("warns when entered ingredient use exceeds the current balance", () => {
  assert.deepEqual(
    findInventoryShortages(
      [{ id: "cheese", ingredientName: "Cheese", unit: "lb", inventoryOnHand: 5 }],
      { cheese: "6.25" },
    ),
    [{ ingredientName: "Cheese", unit: "lb", onHand: 5, enteredUse: 6.25, shortage: 1.25 }],
  );
});

test("combines repeated normalized ingredient lines before comparing stock", () => {
  assert.deepEqual(
    findInventoryShortages(
      [
        { id: "first", ingredientName: "  CHEESE ", unit: "lb", inventoryOnHand: 5 },
        { id: "second", ingredientName: "Cheese", unit: "lb", inventoryOnHand: 5 },
      ],
      { first: "2.5", second: "3" },
    ),
    [{ ingredientName: "  CHEESE ", unit: "lb", onHand: 5, enteredUse: 5.5, shortage: 0.5 }],
  );
});

test("does not warn at the available balance or when stock is unknown", () => {
  assert.deepEqual(
    findInventoryShortages(
      [
        { id: "exact", ingredientName: "Cheese", unit: "lb", inventoryOnHand: 5 },
        { id: "unknown", ingredientName: "Tomato", unit: "lb", inventoryOnHand: null },
      ],
      { exact: "5", unknown: "3" },
    ),
    [],
  );
});

test("ignores blank and invalid amounts and keeps units separate", () => {
  assert.deepEqual(
    findInventoryShortages(
      [
        { id: "blank", ingredientName: "Cheese", unit: "lb", inventoryOnHand: 2 },
        { id: "invalid", ingredientName: "Cheese", unit: "lb", inventoryOnHand: 2 },
        { id: "grams", ingredientName: "Cheese", unit: "g", inventoryOnHand: 2 },
      ],
      { blank: " ", invalid: "-1", grams: "2.5" },
    ),
    [{ ingredientName: "Cheese", unit: "g", onHand: 2, enteredUse: 2.5, shortage: 0.5 }],
  );
});

test("does not warn about a pre-existing negative balance when no stock is used", () => {
  assert.deepEqual(
    findInventoryShortages(
      [{ id: "cheese", ingredientName: "Cheese", unit: "lb", inventoryOnHand: -2 }],
      { cheese: "0" },
    ),
    [],
  );
});
