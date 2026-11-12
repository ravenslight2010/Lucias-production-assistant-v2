import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { parsePremixSheet, premixIssueCount } from '../src/importing/premix.ts';
import { parseOperationalWorkbook } from '../src/importing/operational.ts';

test('premix formulas use only their own columns and keep distinct customer names and source keys', () => {
  const rows = [['Red Hot Chicken Mix', null, null, '# OF MIXES', null, 'Red Hot Bacon Mix', null, null, '# OF MIXES'],
    [null, 'Per Pizza (oz)', 'Per Batch (lbs)', 1, null, null, 'Per Pizza (oz)', 'Per Batch (lbs)', 2],
    ['Chicken', 2, 80, null, null, 'Bacon', 1, 40], ['TOTAL', 2, 80, null, null, 'TOTAL', 1, 40]];
  const before = structuredClone(rows);
  const a = parsePremixSheet({ name: 'Lowes Red Hot', rows });
  const b = parsePremixSheet({ name: 'Nob Hill Red Hot', rows });
  assert.equal(a.recipes.length, 2);
  assert.deepEqual(a.recipes.map(r => r.name), ['Lowes — Red Hot Chicken Mix', 'Lowes — Red Hot Bacon Mix']);
  assert.equal(b.recipes[0].name, 'Nob Hill — Red Hot Chicken Mix');
  assert.notEqual(a.recipes[0].premix.key, b.recipes[0].premix.key);
  assert.deepEqual(a.recipes[0].ingredients[0].amounts.map(a => a.value), [2, 80]);
  assert.deepEqual(a.recipes[1].ingredients[0].amounts.map(a => a.value), [1, 40]);
  assert.deepEqual(rows, before);
});

test('early-pull preparation stays separate from mixes, including quantities and timing', () => {
  const rows = [['Brand Chicken Mix', null, null, '# OF MIXES', null, '***Pull 3 Days Early***'],
    [null, 'Per Pizza (oz)', 'Per Batch (lbs)', 1, null, null, 'Per Pizza (oz)', 'Per Batch (lbs)', 'Total Needed'],
    ['Chicken', 2, 80, null, null, 'Garlic sauce', 1, 40, '2 Buckets'],
    ['Total', 2, 80], [], ['PULL FOR MIX'], ['Chicken', 80, 'POUNDS']];
  const data = parsePremixSheet({ name: 'Synthetic Customer', rows });
  assert.equal(data.recipes.length, 2);
  const [mix, prep] = data.recipes;
  assert.equal(mix.premix.pullInstructions.length, 0);
  assert.equal(prep.premix.section, 'preparation');
  assert.equal(prep.premix.pullInstructions[0].daysEarly, 3);
  assert.equal(prep.ingredients[0].amounts[2].value, '2 Buckets');
  assert.equal(prep.ingredients.length, 1);
  assert.equal(mix.metrics.find(m => m.name === 'Pull: Chicken').amounts[0].label, 'Source amount (POUNDS)');
});

test('preserves allergen and mixing instructions, incomplete quantities and conflicting source totals', () => {
  const rows = [['Lowes Spinach Mix'], [null, 'Per Pizza (oz)', 'Per Batch (lbs)'],
    ['Spinach', 2, 80], ['Extra spinach', null, 5], ['TOTAL', 2, 80],
    [null, null, '***PUT A YELLOW EGG ALLERGEN STICKER ON EVERY BOX***'],
    ['PULL FOR MIX'], ['Spinach', 80], [], ['ADD MELTED BUTTER'], ['MIX 10-15 MIN'], ['***PULL OLD MIX 2 DAYS PRIOR***']];
  const r = parsePremixSheet({ name: 'Lowes Spinach', rows }).recipes[0];
  assert.equal(r.ingredients.length, 2);
  assert.equal(r.ingredients[1].amounts.length, 1);
  assert.equal(r.total.amounts[1].value, 80);
  assert.ok(r.premix.issues.some(i => i.code === 'total_mismatch'));
  assert.ok(r.notes.some(n => n.includes('EGG ALLERGEN')));
  assert.deepEqual(r.steps.map(s => s.text), ['ADD MELTED BUTTER', 'MIX 10-15 MIN']);
  assert.equal(r.premix.pullInstructions.at(-1).daysEarly, 2);
  assert.ok(r.premix.sourceRows.some(row => row.sourceRow === 6 && row.cells[0].column === 3));
});

test('ingredient names containing drained are not instructions and conflicting customer headings are retained', () => {
  const r = parsePremixSheet({ name: 'Basha Ultra Thin Hawaiian', rows: [
    ['Corner Booth Hawaiian'], [null, 'Per Pizza (oz)', 'Per Batch (lbs)'],
    ['Pineapple - Drained', 2, 82.8], [], ['Total Cases Needed', 48], ['***Drain Pinapples***'],
    ['Amount already drained', 0], ['Pull to Drain', 154, 25, 'cans'],
  ] }).recipes[0];
  assert.equal(r.name, 'Basha — Corner Booth Hawaiian');
  assert.equal(r.ingredients[0].name, 'Pineapple - Drained');
  assert.ok(r.premix.issues.some(i => i.code === 'brand_heading_conflict'));
  assert.ok(r.metrics.some(m => m.name === 'Pull to Drain'));
});

const source = path.resolve(import.meta.dirname, '../../../attached_assets/Updated_Pre_Mix_Sheets_1794437188719.xlsx');
test('all 54 uploaded premix tabs preserve separate formulas, preparation, timing, notes and source cells', { skip: !fs.existsSync(source) }, () => {
  const bytes = fs.readFileSync(source), w = XLSX.read(bytes);
  const workbook = { fileName: path.basename(source), sheets: w.SheetNames.map(name => ({
    name, rows: XLSX.utils.sheet_to_json(w.Sheets[name], { header: 1, defval: null }),
  })) };
  const before = structuredClone(workbook);
  const data = parseOperationalWorkbook(workbook, 'premix');
  assert.equal(data.sheets.length, 54);
  assert.ok(data.sheets.every(s => s.recipes.length));
  const recipes = data.sheets.flatMap(s => s.recipes);
  assert.equal(recipes.length, 75);
  assert.equal(new Set(recipes.map(r => r.premix.key)).size, recipes.length);
  assert.equal(recipes.reduce((s,r) => s + r.ingredients.length, 0), 189);
  assert.ok(premixIssueCount(data) >= recipes.length);
  assert.ok(recipes.every(r => r.premix.referenceOnly && r.premix.sourceRows.length));
  const spinach = data.sheets.find(s => s.name === 'Lowes Spinach').recipes[0];
  assert.equal(spinach.premix.pullInstructions[0].daysEarly, 2);
  assert.ok(spinach.notes.some(n => n.includes('EGG ALLERGEN')));
  assert.equal(spinach.steps.length, 6);
  const hot = data.sheets.find(s => s.name === 'Lowes Red Hot').recipes;
  assert.equal(hot.length, 3);
  assert.equal(hot[2].premix.pullInstructions[0].daysEarly, 3);
  assert.ok(hot[1].premix.issues.some(i => i.code === 'total_mismatch'));
  assert.deepEqual(hot[0].ingredients[0].amounts.map(a => a.value), [0.07, 2.898]);
  assert.equal(data.sheets.find(s => s.name === 'Basha Ultra Thin Hawaiian').recipes.length, 2);
  assert.deepEqual(workbook, before);
  const selected = parseOperationalWorkbook(workbook, 'premix', ['Lowes Red Hot']);
  assert.equal(selected.sheets.length, 1);
  assert.equal(selected.sheets[0].recipes.length, 3);
});
