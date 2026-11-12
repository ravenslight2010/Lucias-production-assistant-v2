import test from 'node:test';
import assert from 'node:assert/strict';
import { premixImportReviewIdentity } from '../src/lib/premix-import-review.ts';

const source = () => ({ structured: { importKind: 'premix', premixReview: { reviewedAsReference: true }, sheets: [
  { name: 'Brand B', recipes: [{ premix: { format: 'lucia.premix-details.v1', key: '["Brand B",3,1]', referenceOnly: true, issues: [] } }] },
  { name: 'Brand A', recipes: [{ premix: { format: 'lucia.premix-details.v1', key: '["Brand A",3,1]', referenceOnly: true, issues: [] } }] },
] } });
test('premix identities are stable across ordering, distinct by selection, and leave legacy sources readable', () => {
  const a = source(), b = source();
  b.structured.sheets.reverse();
  assert.equal(premixImportReviewIdentity(a), premixImportReviewIdentity(b));
  b.structured.sheets.pop();
  assert.notEqual(premixImportReviewIdentity(a), premixImportReviewIdentity(b));
  assert.equal(premixImportReviewIdentity({ structured: { importKind: 'premix', sheets: [{ recipes: [{}] }] } }), null);
  assert.equal(premixImportReviewIdentity({ structured: { importKind: 'cheese' } }), null);
});
test('new premix sources require reference acknowledgement and valid unique source coordinates', () => {
  for (const mutate of [
    d => { delete d.structured.premixReview; },
    d => { d.structured.premixReview.reviewedAsReference = false; },
    d => { d.structured.sheets.push(d.structured.sheets[0]); },
    d => { d.structured.sheets[0].recipes.push(d.structured.sheets[0].recipes[0]); },
    d => { d.structured.sheets[0].recipes[0].premix.key = '["Other Brand",3,1]'; },
    d => { d.structured.sheets[0].recipes[0].premix.key = '["Brand B",0,1]'; },
    d => { d.structured.sheets[0].recipes[0].premix.referenceOnly = false; },
  ]) {
    const d = source(); mutate(d); assert.throws(() => premixImportReviewIdentity(d));
  }
});
