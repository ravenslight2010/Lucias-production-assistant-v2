import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOperationalWorkbook } from '../src/importing/operational.ts';
import { doughPortionChoices, scopeDoughWorkbook } from '../src/importing/dough.ts';

const workbook = rows => ({
  fileName: 'Sample_Dough_Mixing_Procedure.xlsx', sizeBytes: 1,
  sheetCount: 1, cellCount: 0, kind: 'dough_guide', kindConfidence: 'high',
  sheets: [{ name: 'Sheet1', rows }],
});
const parse = source => parseOperationalWorkbook(source, 'dough_guide');
const recipe = data => data.sheets[0].recipes[0];

test('keeps unquantified ingredients and inline cautions instead of dropping them', () => {
  const data = parse(workbook([
    ['Sample dough'],
    [null, null, 'LBS.'],
    ['Flour', null, 200],
    ['Water', null, 101.5, null, 'Use the correct customer recipe'],
    ['French fries', null, ' ', '(4 bags)'],
    ['Total', null, 328.5],
    ['1. ADD 103 LB OF WATER AT 95F'],
    [null, 'OZ.', 'LBS.', 'YIELD', 'PER TRAY'],
    ['Heavy', 15, 0.99, 369.6, 15],
  ]));
  assert.equal(recipe(data).ingredients.length, 3);
  assert.deepEqual(recipe(data).ingredients[2].amounts, []);
  assert.ok(recipe(data).notes.some(note => note.includes('correct customer recipe')));
  assert.ok(recipe(data).notes.some(note => note.includes('(4 bags)')));
  assert.ok(recipe(data).dough.issues.some(issue => issue.code === 'missing_amount'));
  assert.ok(recipe(data).dough.issues.some(issue => issue.code === 'instruction_quantity_conflict'));
  assert.ok(recipe(data).dough.issues.some(issue => issue.code === 'portion_weight_conflict'));
  assert.equal(recipe(data).dough.batches[0].ingredientSum, null);
});

test('extracts padded product labels, fractional yields, and all CRB mapping variants', () => {
  const data = parse(workbook([
    ['CRB DOUGH'],
    ["Lowe's CRB Heavier: Spinach Mushroom"],
    ["Lowe's CRB Heavy Plus: Caribbean"],
    ['Nob Hill Craft Heavy Plus: Caribbean'],
    [null, null, 'LBS.'],
    ['Flour', null, 200],
    ['Total', null, 200],
    ['1. Mix flour'],
    [null, null, 'OZ.', 'LBS.', 'YIELD', 'PER TRAY'],
    [null, 'Heavy Plus', 12, 0.75, 266.6666666666667, 16],
  ]));
  assert.equal(data.sheets[0].productMappings.length, 3);
  assert.deepEqual(recipe(data).dough.portions[0], {
    product: 'Heavy Plus', sourceRow: 10, ounces: 12, pounds: 0.75,
    yield: 266.6666666666667, perTray: 16,
  });
  assert.equal(recipe(data).ingredients.length, 1);
});

test('retains batch variants and validates the chosen column without mutating original data', () => {
  const source = workbook([
    ['Sample dough'], [null, null, 'LBS.', null, 'LBS.'],
    ['Flour', null, 200, 6.666666667, 200],
    ['Dough conditioner UFI-U1420', null, 1.75, 0.05833333333, 4],
    ['Total', null, 201.75, 6.72500000033, 204],
    ['1. ADD 4 LBS OF DOUGH CONDITIONER'],
    [null, null, 'OZ.', 'LBS.', 'YIELD', 'PER TRAY'],
    ['Classic', null, 12, 0.75, 269, 16],
    ['Heavy', null, 16, 1, 201.75, 12],
  ]);
  const data = parse(source);
  const before = JSON.stringify({ source, data });
  assert.equal(recipe(data).dough.batches.length, 3);
  assert.ok(recipe(data).dough.issues.some(issue => issue.code === 'unlabeled_batch'));
  assert.ok(recipe(data).dough.issues.some(issue => issue.code === 'multiple_batches'));
  const choice = doughPortionChoices(data)[0];
  const first = scopeDoughWorkbook(source, data, choice.key, 3, true);
  assert.equal(recipe(first).dough.portions.length, 1);
  assert.deepEqual(recipe(first).ingredients[1].amounts.map(amount => amount.value), [1.75]);
  assert.ok(recipe(first).dough.issues.some(issue => issue.code === 'instruction_quantity_conflict'));
  assert.equal(recipe(first).dough.selection.reviewedAsReference, true);
  const alternate = scopeDoughWorkbook(source, data, choice.key, 5);
  assert.equal(recipe(alternate).dough.issues.some(issue => issue.code === 'instruction_quantity_conflict'), false);
  assert.equal(JSON.stringify({ source, data }), before);
  assert.throws(() => scopeDoughWorkbook(source, data, choice.key, 299));
  assert.throws(() => scopeDoughWorkbook(source, data, 'stale-source-choice', 3));
});

test('flags total discrepancies and duplicate numbering but preserves worksheet order and instructions', () => {
  const data = parse(workbook([
    ['Sample dough'], [null, 'LBS.'], ['Flour', 100], ['Water', 50],
    ['Total', 160],
    ['1. SET WATER TO 50 LBS & TEMP TO 115'],
    ['2. Mix slowly'], ['2. Add remaining ingredients'], ['1. Stop mixer'],
    [null, 'OZ.', 'LBS.', 'YIELD', 'PER TRAY'], ['Classic', 8, 0.5, 320, 24],
  ]));
  assert.deepEqual(recipe(data).steps.map(step => step.order), [1, 2, 2, 1]);
  assert.ok(recipe(data).dough.issues.some(issue => issue.code === 'total_mismatch'));
  assert.equal(recipe(data).dough.issues.filter(issue => issue.code === 'step_numbering').length, 2);
  assert.equal(recipe(data).dough.issues.some(issue => issue.code === 'instruction_quantity_conflict'), false);
});

test('keeps two-bag, four-bag, and five-bag weights distinct rather than assuming one batch', () => {
  const data = parse(workbook([
    ['Sample dough'], ['LBS.', null, '2 Bag', '4 Bag', '5 Bag'],
    ['Flour', null, 100, 200, 250], ['Water', null, 40, 80, 100],
    ['TOTAL WEIGHT', null, 140, 280, 350], ['1. SET WATER TO 80 LBS & TEMP TO 140'],
    [null, 'OZ.', 'LBS.', 'YIELD', 'PER TRAY'], ['Classic', 8, 0.5, 560, 24],
  ]));
  assert.deepEqual(recipe(data).dough.batches.map(batch => [batch.label, batch.total]), [
    ['2 Bag', 140], ['4 Bag', 280], ['5 Bag', 350],
  ]);
  assert.equal(recipe(data).dough.issues.some(issue => issue.code === 'instruction_quantity_conflict'), false);
});
