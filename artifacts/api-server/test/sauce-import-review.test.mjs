import test from 'node:test';
import assert from 'node:assert/strict';
import { sauceImportReviewIdentity } from '../src/lib/sauce-import-review.ts';

const data = (reviewed = false, issues = []) => ({ structured: {
  importKind: 'sauce_guide', sauceReview: { reviewedAsReference: reviewed },
  sheets: [{ name: 'Sauce', recipes: [{ sauce: { format: 'lucia.sauce-details.v1', referenceOnly: true, issues } }] }],
} });
test('sauce review identity is stable and distinguishes source-sheet selections from legacy imports', () => {
  const value = data();
  assert.equal(sauceImportReviewIdentity(value), sauceImportReviewIdentity(structuredClone(value)));
  assert.equal(sauceImportReviewIdentity({ structured: { importKind: 'sauce_guide', sheets: [{ name: 'Sauce', recipes: [] }] } }), null);
  const second = structuredClone(value);
  second.structured.sheets[0].name = 'Other';
  assert.notEqual(sauceImportReviewIdentity(value), sauceImportReviewIdentity(second));
  assert.equal(sauceImportReviewIdentity({ structured: { importKind: 'cheese' } }), null);
});
test('sauce source warnings require an explicit reference review without approving alternatives', () => {
  assert.throws(() => sauceImportReviewIdentity(data(false, [{ code: 'alternative_reference' }])));
  assert.ok(sauceImportReviewIdentity(data(true, [{ code: 'alternative_reference' }])));
  const approved = data(true);
  approved.structured.sheets[0].recipes[0].sauce.referenceOnly = false;
  assert.throws(() => sauceImportReviewIdentity(approved));
  const missing = data();
  delete missing.structured.sauceReview;
  assert.throws(() => sauceImportReviewIdentity(missing));
});
test('sauce review rejects malformed, duplicate or oversized source selections', () => {
  const malformed = data();
  malformed.structured.sheets[0].recipes.push({});
  assert.throws(() => sauceImportReviewIdentity(malformed));
  const duplicate = data();
  duplicate.structured.sheets.push(duplicate.structured.sheets[0]);
  assert.throws(() => sauceImportReviewIdentity(duplicate));
  const large = data(true, Array.from({ length: 101 }, () => ({})));
  assert.throws(() => sauceImportReviewIdentity(large));
});
