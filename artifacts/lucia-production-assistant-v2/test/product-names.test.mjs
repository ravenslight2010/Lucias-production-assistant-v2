import assert from 'node:assert/strict';
import test from 'node:test';
import { indexProductNames, productNameKey } from '../src/importing/product-names.ts';

test('remembered brand/flavor pairs match their surviving profiles with exact normalization', () => {
  const profile = { id: 'kept', brand: 'Current Brand', flavor: 'Current Flavor', revision: 4 };
  const index = indexProductNames([profile], [
    { brand: 'Former Brand', flavor: 'Former Flavor', profileId: 'kept' },
    { brand: 'Merged Brand', flavor: 'Merged Flavor', profileId: 'kept' },
  ]);
  for (const [brand, flavor] of [['Current Brand', 'Current Flavor'], ['  FORMER  BRAND ', 'former flavor'], ['Ｍerged Brand', 'Merged Flavor']]) {
    assert.equal(index.get(productNameKey(brand, flavor)), profile);
  }
  assert.equal(index.get(productNameKey('Former Brand', 'Different Flavor')), undefined);
  assert.equal(index.get(productNameKey('FormerBrand', 'Former Flavor')), undefined);
});

test('missing or conflicting alias data never replaces a canonical match', () => {
  const profile = { id: 'kept', brand: 'Brand', flavor: 'Flavor' };
  const other = { id: 'other', brand: 'Other', flavor: 'Other' };
  const index = indexProductNames([profile, other], [
    { brand: 'Brand', flavor: 'Flavor', profileId: 'other' },
    { brand: 'Missing', flavor: 'Missing', profileId: 'not-active' },
  ]);
  assert.equal(index.get(productNameKey('Brand', 'Flavor')), profile);
  assert.equal(index.has(productNameKey('Missing', 'Missing')), false);
});
