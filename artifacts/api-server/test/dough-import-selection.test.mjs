import test from "node:test";
import assert from "node:assert/strict";
import { doughImportSelectionIdentity } from "../src/lib/dough-import-selection.ts";

function data(column = 3, row = 40) {
  return { structured: { importKind: "dough_guide", sheets: [{ name: "Sheet1", recipes: [{
    ingredients: [{ amounts: [{ column, value: 200 }] }],
    dough: {
      selection: { batchColumn: column, portionSourceRow: row, reviewedAsReference: false },
      portions: [{ sourceRow: row }], batches: [{ column }], issues: [],
    },
  }] }] } };
}
test("dough retries keep the same selection identity and distinguish a changed batch or portion", () => {
  assert.equal(doughImportSelectionIdentity(data()), doughImportSelectionIdentity(JSON.parse(JSON.stringify(data()))));
  assert.notEqual(doughImportSelectionIdentity(data()), doughImportSelectionIdentity(data(4)));
  assert.notEqual(doughImportSelectionIdentity(data()), doughImportSelectionIdentity(data(3, 41)));
});
test("rejects mismatched columns and unacknowledged source discrepancies", () => {
  const mismatch = data();
  mismatch.structured.sheets[0].recipes[0].ingredients[0].amounts[0].column = 4;
  assert.throws(() => doughImportSelectionIdentity(mismatch));
  const unreviewed = data();
  unreviewed.structured.sheets[0].recipes[0].dough.issues.push({ code: "total_mismatch" });
  assert.throws(() => doughImportSelectionIdentity(unreviewed));
  unreviewed.structured.sheets[0].recipes[0].dough.selection.reviewedAsReference = true;
  assert.ok(doughImportSelectionIdentity(unreviewed));
});
test("keeps legacy and other workbook imports on their existing retry identity", () => {
  assert.equal(doughImportSelectionIdentity({ structured: { importKind: "dough_guide", sheets: [] } }), null);
  assert.equal(doughImportSelectionIdentity({ structured: { importKind: "cheese" } }), null);
  assert.equal(doughImportSelectionIdentity({}), null);
});
