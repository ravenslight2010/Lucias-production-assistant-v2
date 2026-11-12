import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveReferenceName } from '../src/importing/reference-names.ts';
import { indexProductNames, productNameKey } from '../src/importing/product-names.ts';
const ref = (kind, name, brand = 'Lucia') => ({ kind, name, brand: kind === 'brand' ? '' : brand });
test('explicit recipe aliases preserve brand/type boundaries and resolve after brand renames', () => {
  const rules = [
    { source: ref('recipe', 'Lucia Style'), target: ref('recipe', 'Lucia Sauce') },
    { source: ref('brand', 'Lucia'), target: ref('brand', 'Lucia Foods') },
    { source: ref('recipe', 'Lucia Style', 'Lucia Foods'), target: ref('recipe', 'Lucia Sauce', 'Lucia Foods') },
  ];
  assert.deepEqual(resolveReferenceName(ref('recipe', '  LUCIA   STYLE ', 'Lucia Foods'), rules), ref('recipe', 'Lucia Sauce', 'Lucia Foods'));
  assert.deepEqual(resolveReferenceName(ref('recipe', 'Lucia Style', 'Other'), rules), ref('recipe', 'Lucia Style', 'Other'));
  assert.deepEqual(resolveReferenceName(ref('ingredient', 'Lucia Style'), rules), ref('ingredient', 'Lucia Style', 'Lucia Foods'));
});
test('old brand plus a newly seen flavor matches the canonical product without needing every historical pair', () => {
  const profile = { id: 'canonical', brand: 'Lucia Foods', flavor: 'New Flavor' };
  const rules = [{ source: ref('brand', 'Lucia'), target: ref('brand', 'Lucia Foods') }];
  const index = indexProductNames([profile], [], rules);
  assert.equal(index.get(productNameKey('Lucia', 'New Flavor')), profile);
  assert.equal(index.get(productNameKey('Other', 'New Flavor')), undefined);
  assert.equal(index.get(productNameKey('Lucia', 'Missing')), undefined);
});
test('cycles and conflicting aliases are rejected instead of guessed', () => {
  assert.throws(() => resolveReferenceName(ref('recipe', 'A'), [
    { source: ref('recipe', 'A'), target: ref('recipe', 'B') },
    { source: ref('recipe', 'B'), target: ref('recipe', 'A') },
  ]), /circular/);
});
test('canonical namespace bindings follow later brand renames without applying another brands flavor aliases', () => {
  const rules = [
    { source: ref('flavor', 'Cheese', 'Other'), target: ref('flavor', 'Other Flavor', 'Other') },
    { source: ref('brand', 'Other'), target: ref('brand', 'Lucia') },
    { source: ref('flavor', 'Cheese'), target: ref('flavor', 'Cheese') },
    { source: ref('brand', 'Lucia'), target: ref('brand', 'Unified') },
  ];
  assert.deepEqual(resolveReferenceName(ref('flavor', 'Cheese'), rules), ref('flavor', 'Cheese', 'Unified'));
  assert.deepEqual(resolveReferenceName(ref('flavor', 'Cheese', 'Unified'), rules), ref('flavor', 'Cheese', 'Unified'));
  assert.deepEqual(resolveReferenceName(ref('flavor', 'Cheese', 'Other'), rules), ref('flavor', 'Other Flavor', 'Unified'));
});
