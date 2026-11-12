import test from 'node:test';
import assert from 'node:assert/strict';
import { cheeseImportSelectionIdentity } from '../src/lib/cheese-import-selection.ts';

function data(column = 2, name = 'Brand A') {
  const key = JSON.stringify([name, 3, column]);
  return { structured: { importKind: 'cheese', cheeseSelection: { keys: [key], reviewedAsReference: false }, sheets: [{
    name, recipes: [{
      name: `${name} — Shared Mix`, source: { sheet: name },
      ingredients: [{ amounts: [{ column, label: 'LBS', value: 20 }] }],
      total: { amounts: [{ column, label: 'LBS', value: 20 }] },
      cheese: { format: 'lucia.cheese-details.v1', key, brand: name, sourceName: 'Shared Mix', headerRow: 3, sourceColumn: column, issues: [] },
    }],
  }] } };
}
test('cheese retry identities distinguish customers and source columns without changing legacy imports', () => {
  assert.equal(cheeseImportSelectionIdentity(data()), cheeseImportSelectionIdentity(data()));
  assert.notEqual(cheeseImportSelectionIdentity(data()), cheeseImportSelectionIdentity(data(5)));
  assert.notEqual(cheeseImportSelectionIdentity(data()), cheeseImportSelectionIdentity(data(2, 'Brand B')));
  assert.equal(cheeseImportSelectionIdentity({ structured: { importKind: 'cheese', sheets: [] } }), null);
  assert.equal(cheeseImportSelectionIdentity({ structured: { importKind: 'premix' } }), null);
});
test('rejects missing selections, duplicate formulas, cross-customer names and mixed amount columns', () => {
  const missing = data(); delete missing.structured.cheeseSelection;
  assert.throws(() => cheeseImportSelectionIdentity(missing));
  const duplicate = data(); duplicate.structured.sheets[0].recipes.push(duplicate.structured.sheets[0].recipes[0]);
  assert.throws(() => cheeseImportSelectionIdentity(duplicate));
  const renamed = data(); renamed.structured.sheets[0].recipes[0].name = 'Brand B — Shared Mix';
  assert.throws(() => cheeseImportSelectionIdentity(renamed));
  const mixed = data(); mixed.structured.sheets[0].recipes[0].ingredients[0].amounts[0].column = 5;
  assert.throws(() => cheeseImportSelectionIdentity(mixed));
  const total = data(); total.structured.sheets[0].recipes[0].total.amounts[0].column = 5;
  assert.throws(() => cheeseImportSelectionIdentity(total));
});
test('requires acknowledgement of cheese source issues and accepts annotated reference weights', () => {
  const d = data();
  d.structured.sheets[0].recipes[0].cheese.issues = [{ code: 'annotated_weight' }];
  d.structured.sheets[0].recipes[0].ingredients[0].amounts[0].value = '14 (1/3 block)';
  assert.throws(() => cheeseImportSelectionIdentity(d));
  d.structured.cheeseSelection.reviewedAsReference = true;
  assert.ok(cheeseImportSelectionIdentity(d));
});
