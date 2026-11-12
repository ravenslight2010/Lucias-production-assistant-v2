import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { parseOperationalWorkbook } from '../src/importing/operational.ts';
import { sauceIssueCount } from '../src/importing/sauce.ts';

const parse = rows => parseOperationalWorkbook({
  fileName: 'sauce.xlsx', sizeBytes: 1, sheetCount: 1, cellCount: 1,
  kind: 'sauce_guide', kindConfidence: 'high', sheets: [{ name: 'Sauce', rows }],
}, 'sauce_guide');

test('sauce preserves annotated quantities without dropping rows or converting units', () => {
  const rows = [['Buffalo Sauce'], [null, 'LBS'], ['Base', '400 (1 barrel)'], ['Hot sauce', '16 (2 gallons)'], ['TOTAL WEIGHT', 416], ['1. Mix']];
  const before = structuredClone(rows), data = parse(rows), recipe = data.sheets[0].recipes[0];
  assert.equal(recipe.ingredients.length, 2);
  assert.deepEqual(recipe.ingredients.map(i => i.amounts[0].value), ['400 (1 barrel)', '16 (2 gallons)']);
  assert.equal(recipe.total.amounts[0].value, 416);
  assert.ok(recipe.sauce.issues.some(i => i.code === 'annotated_quantity'));
  assert.equal(recipe.sauce.referenceOnly, true);
  assert.deepEqual(rows, before);
});

test('sauce keeps batch sizes, ingredient annotations and source conflicts', () => {
  const data = parse([['Sauce'], [null, '1 Bag', '2 Bags'], [null, 'LBS.', 'LBS.'],
    ['Water', 10, 20, '*Add 2lb if a day prior'], ['Mix', 5, 10], ['TOTAL WEIGHT', 15, 30],
    ['1. Set water to 12'], ['2. Mix'], ['2. Check']]);
  const r = data.sheets[0].recipes[0];
  assert.deepEqual(r.ingredients[0].amounts.map(a => a.label), ['1 Bag (LBS.)', '2 Bags (LBS.)']);
  assert.ok(r.notes.some(n => n.includes('Add 2lb if a day prior')));
  assert.ok(r.sauce.issues.some(i => i.code === 'water_instruction_conflict'));
  assert.ok(r.sauce.issues.some(i => i.code === 'repeated_step_number'));
  assert.ok(r.sauce.issues.some(i => i.code === 'conditional_adjustment'));
  assert.deepEqual(r.steps.map(s => s.order), [1, 2, 2]);
  assert.equal(r.ingredients[0].amounts[0].value, 10);
});

test('sauce does not assume Full/Half units, fill missing quantities, or hide mismatched totals', () => {
  const data = parse([['Gravy Sauce'], ['DRUM BATCH', 'Full', 'Half'], ['Water', 20, 10],
    ['Mix', 4, null], ['TOTAL WEIGHT', 25, 12], ['1. Blend']]);
  const r = data.sheets[0].recipes[0];
  assert.deepEqual(r.ingredients[1].amounts.map(a => a.value), [4]);
  assert.equal(r.total.amounts[0].value, 25);
  for (const code of ['missing_quantity', 'total_mismatch', 'unit_not_stated']) assert.ok(r.sauce.issues.some(i => i.code === code));
  assert.ok(!data.warnings.some(w => w.includes('No ingredient table')));
});

test('annotated sauce tables survive even without a process or equipment section', () => {
  const data = parse([['Buffalo Sauce'], [null, 'LBS'], ['Base', '400 (1 barrel)'], ['TOTAL WEIGHT', 400]]);
  assert.equal(data.sheets[0].recipes[0].ingredients[0].amounts[0].value, '400 (1 barrel)');
  assert.ok(!data.warnings.some(w => w.includes('No ingredient table') || w.includes('No recipe table')));
});
test('sauce process references may exist without a complete recipe and stay flagged', () => {
  const data = parse([['Sauce instructions'], ['Process'], ['1. Blend'], ['2. Heat']]);
  assert.equal(data.sheets[0].recipes[0].ingredients.length, 0);
  assert.ok(sauceIssueCount(data) > 0);
  assert.ok(data.warnings.some(w => w.includes('No ingredient table')));
});

const assets = path.resolve(import.meta.dirname, '../../../attached_assets');
const files = fs.readdirSync(assets).filter(f => /(?:Sauce|Tikka).*\.xlsx$/.test(f)).sort();
test('all 14 uploaded sauce/process guides preserve source formulas, alternatives and native units', { skip: files.length !== 14 ? 'Uploaded source fixtures unavailable' : false }, () => {
  const results = files.map(file => {
    const bytes = fs.readFileSync(path.join(assets, file));
    const x = XLSX.read(bytes, { type: 'buffer' });
    const sheets = x.SheetNames.map(name => ({ name, rows: XLSX.utils.sheet_to_json(x.Sheets[name], { header: 1, defval: null }) }));
    const source = { fileName: file, sizeBytes: bytes.length, sheetCount: sheets.length, cellCount: 1,
      kind: 'sauce_guide', kindConfidence: 'high', sheets };
    const before = structuredClone(source);
    const data = parseOperationalWorkbook(source, 'sauce_guide');
    assert.deepEqual(source, before);
    return { file, data, recipes: data.sheets.flatMap(s => s.recipes) };
  });
  const get = prefix => results.find(r => r.file.startsWith(prefix));
  assert.equal(results.flatMap(r => r.recipes).length, 17);
  assert.equal(results.flatMap(r => r.recipes).reduce((n, r) => n + r.ingredients.length, 0), 108);
  assert.equal(results.flatMap(r => r.recipes).reduce((n, r) => n + r.steps.length, 0), 107);
  assert.equal(get("Bobo's_Buffalo").recipes[0].ingredients[0].amounts[0].value, '400 (1 barrel)');
  const four = get('Four_Hands').recipes;
  assert.equal(four.length, 4);
  assert.equal(four[0].ingredients[0].name, 'Red Hot Sauce (Old Vienna)');
  assert.equal(four[0].ingredients[0].amounts[0].value, '5 - 1 gallons');
  assert.equal(four[0].total.amounts[0].value, '~ 82 lbs');
  assert.ok(four[0].notes.some(n => n.includes('pulled 2 days')));
  assert.equal(four[0].equipment.length, 5);
  assert.ok(four[1].name.includes('Tested and Good'));
  assert.ok(four[2].name.includes('Not Tested Yet'));
  assert.equal(four[2].ingredients[0].amounts.length, 0);
  assert.equal(four[1].ingredients[1].amounts[0].value, 145);
  assert.equal(four[2].ingredients[1].amounts[0].value, 187);
  assert.equal(four[3].ingredients[1].amounts[0].value, 65.5);
  assert.ok(four.slice(1).every(r => r.steps.length === 0 && r.sauce.referenceOnly));
  const chili = get('Sweet_Chili').recipes[0];
  assert.equal(chili.ingredients[0].amounts.length, 6);
  assert.equal(chili.ingredients[0].amounts[5].label, '6 Bags (LBS.)');
  const tikka = get('Tikka').recipes[0];
  assert.equal(tikka.ingredients.length, 21);
  assert.equal(tikka.ingredients[0].amounts[0].label, 'qt');
  assert.equal(tikka.ingredients[0].amounts[0].value, 28);
  assert.equal(tikka.ingredients.find(i => i.name === 'Bay Leaves').amounts[0].label, 'Each');
  assert.equal(tikka.ingredients[0].amounts.length, 4);
  assert.equal(tikka.total, undefined);
  assert.equal(tikka.metrics.find(m => m.name === 'Source batch count').amounts[0].value, 6);
  assert.ok(get("Medulla").recipes[0].sauce.issues.some(i => i.code === 'water_instruction_conflict'));
  assert.ok(results.every(r => r.recipes.every(recipe => recipe.sauce.referenceOnly)));
});
