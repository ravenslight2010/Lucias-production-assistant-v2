import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseOperationalWorkbook } from '../src/importing/operational.ts';
import { cheeseRecipeChoices, scopeCheeseWorkbook } from '../src/importing/cheese.ts';

const wb = sheets => ({ fileName: 'Cheese_Mix.xlsx', sheets, kind: 'cheese' });
const sheet = (name, rows) => ({ name, rows });
const rows = [
  ['Shared Cheese Mix'], [null, 'LBS'], ['Mozzarella', 20], ['Cellulose', 0.3], ['Total', 20.3],
  [null, 'LBS'], ['Cellulose', 0.3], ['Percent', 1.48],
];
const parse = sheets => parseOperationalWorkbook(wb(sheets), 'cheese');

test('brand prefixes distinguish identical names and cellulose summaries are not recipes', () => {
  const d = parse([sheet('Brand A', rows), sheet('Brand B', rows)]);
  assert.deepEqual(d.sheets.map(s => s.recipes.length), [1, 1]);
  assert.deepEqual(d.sheets.map(s => s.recipes[0].name), ['Brand A — Shared Cheese Mix', 'Brand B — Shared Cheese Mix']);
  assert.equal(d.sheets[0].recipes[0].metrics[1].name, 'Percent');
  assert.equal(d.sheets[0].recipes[0].metrics[1].amounts[0].label, 'Source percent');
  assert.equal(d.sheets[0].recipes[0].cheese.sourceName, 'Shared Cheese Mix');
});

test('parallel tables never leak amounts, including unlabelled totals and applicator notes', () => {
  const d = parse([sheet('Brand', [
    ['Shared Mix', null, null, 'Shared Mix'],
    ['For 1st Cheese Applicator', null, null, 'For 2nd Cheese Applicator'],
    [null, 'LBS', null, null, 'LBS'],
    ['Mozzarella', 20, null, 'Cheddar', 30],
    ['Total', 20, null, null, 30],
  ])]);
  const [a, b] = d.sheets[0].recipes;
  assert.equal(a.total.amounts.length, 1);
  assert.equal(a.total.amounts[0].value, 20);
  assert.equal(b.total.amounts[0].value, 30);
  assert.equal(a.cheese.applicator, 'For 1st Cheese Applicator');
  assert.equal(b.cheese.applicator, 'For 2nd Cheese Applicator');
  assert.notEqual(a.cheese.key, b.cheese.key);
  assert.ok(b.cheese.issues.some(i => i.code === 'unlabelled_total'));
});

test('annotated weights, zero weights, missing ingredients, and source totals stay intact', () => {
  const d = parse([sheet('Brand', [
    ['Example Mix'], [null, 'LBS'], ['Parmesan Oregano Mix', '0.112 (1.8oz)'],
    ['Nutmeg', '0.06 (1.0oz)'], ['No Cellulose', 0], ['Basil', null], ['Total', 1],
  ])]);
  const r = d.sheets[0].recipes[0];
  assert.equal(r.ingredients.length, 4);
  assert.equal(r.ingredients[0].amounts[0].value, '0.112 (1.8oz)');
  assert.equal(r.ingredients[2].amounts[0].value, 0);
  assert.deepEqual(r.ingredients[3].amounts, []);
  assert.equal(r.cheese.ingredientSum, null);
  for (const code of ['annotated_weight', 'submix_reference', 'missing_weight']) assert.ok(r.cheese.issues.some(i => i.code === code));
  const incomplete = parse([sheet('Brand', [['Partial Mix'], [null, 'LBS'], ['Swiss', null], ['Cellulose', 0.3], ['Total']])]);
  assert.equal(incomplete.sheets[0].recipes.length, 1);
  assert.ok(incomplete.sheets[0].recipes[0].cheese.issues.some(i => i.code === 'missing_total'));
});

test('exact formula selection is immutable, customer-scoped, and keeps original mappings', () => {
  const d = parse([sheet('A', [['Pepperoni: Shared Mix'], ...rows]), sheet('B', rows)]);
  const before = JSON.stringify(d);
  const options = cheeseRecipeChoices(d);
  const selected = scopeCheeseWorkbook(d, [options[0].key], true);
  assert.equal(selected.sheets.length, 1);
  assert.equal(selected.sheets[0].productMappings[0].product, 'Pepperoni');
  assert.equal(selected.cheeseSelection.reviewedAsReference, true);
  assert.equal(JSON.stringify(d), before);
  assert.throws(() => scopeCheeseWorkbook(d, []));
  assert.throws(() => scopeCheeseWorkbook(d, ['unknown']));
  assert.throws(() => scopeCheeseWorkbook(d, [options[0].key, options[0].key]));
  assert.throws(() => scopeCheeseWorkbook(d, options.map(c => c.key)), /one customer/);
});

test('mismatched totals warn without correcting source quantities', () => {
  const r = parse([sheet('Brand', [['Example Mix'], [null, 'LBS'], ['Cheese', 43], ['Cellulose', 0.3], ['Total', 44.3]])]).sheets[0].recipes[0];
  assert.equal(r.total.amounts[0].value, 44.3);
  assert.ok(r.cheese.issues.some(i => i.code === 'total_mismatch'));
});

test('footer revisions and possible cellulose percentage-basis conflicts are retained for review', () => {
  const d = parse([sheet('Brand', [
    ['Shared Mix'], [null, 'LBS'], ['Mozzarella', 20], ['Cellulose', 0.3], ['Total', 20.3],
    [null, 'LBS'], ['Cellulose', 0.3], ['Percent', 0.12],
    [], [], [], ['03/14/25 Rev. 1'],
  ])]);
  assert.equal(d.revision, '1');
  assert.equal(d.sheets[0].recipes.length, 1);
  assert.ok(d.sheets[0].recipes[0].cheese.issues.some(i => i.code === 'percent_basis_review'));
  assert.equal(d.sheets[0].recipes[0].metrics[1].amounts[0].value, 0.12);
});

const asset = new URL('../../../attached_assets/Cheese_Mix_Recipe_Specs_-_Tabbed_by_Customer_-_10.08.26_1794437148886.xlsx', import.meta.url);
test('uploaded customer workbook extracts 130 formulas with no percentage-block duplicates', { skip: !fs.existsSync(asset) }, async () => {
  const { default: XLSX } = await import('xlsx');
  const xlsx = XLSX.read(fs.readFileSync(asset));
  const d = parse(xlsx.SheetNames.map(name => sheet(name, XLSX.utils.sheet_to_json(xlsx.Sheets[name], { header: 1, defval: null }))));
  assert.equal(d.sheets.length, 28);
  const recipes = d.sheets.flatMap(s => s.recipes);
  assert.equal(recipes.length, 130);
  assert.equal(recipes.reduce((sum, r) => sum + r.ingredients.length, 0), 427);
  assert.equal(new Set(recipes.map(r => r.cheese.key)).size, 130);
  assert.equal(d.sheets.find(s => s.name === 'Lowe').recipes.length, 17);
  assert.equal(d.sheets.find(s => s.name === 'Corner Booth').recipes.length, 6);
  assert.equal(d.sheets.find(s => s.name === 'Lucia Morning Melts').recipes.length, 4);
  assert.ok(recipes.find(r => r.cheese.sourceName.includes('Parisian')).cheese.issues.some(i => i.code === 'missing_weight'));
  const expectedCounts = [2,2,6,3,1,6,1,3,6,1,9,9,17,7,5,9,8,4,5,3,2,1,5,4,1,5,2,3];
  assert.deepEqual(d.sheets.map(s => s.recipes.length), expectedCounts);
  for (const r of recipes) {
    assert.ok(r.name.startsWith(`${r.source.sheet} — `));
    assert.ok(!/^(?:percent|cellulose)$/i.test(r.cheese.sourceName));
    assert.ok(r.ingredients.every(i => i.amounts.every(a => a.column === r.cheese.sourceColumn)));
  }
});
