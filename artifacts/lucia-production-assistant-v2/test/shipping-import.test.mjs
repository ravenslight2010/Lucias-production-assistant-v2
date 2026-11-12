import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as XLSX from 'xlsx';
import { parseShippingSheet, shippingChoices, scopeShippingWorkbook } from '../src/importing/shipping.ts';
import { parseOperationalWorkbook } from '../src/importing/operational.ts';

const workbook = sheets => ({ fileName: 'Shipping.xlsx', sheets, sheetCount: sheets.length, sizeBytes: 1, cellCount: 1, kind: 'shipping', kindConfidence: 'high' });
const headers = ['PIZZA', 'BOX', 'PIZZAS/CS', 'CASES', 'GRIPSHEEETS', 'PALLET HEIGHT'];

test('keeps source coordinates, multipack meaning, missing heights and grip-sheet uncertainty', () => {
  const source = { name: 'Guide', rows: [headers, ['Customer', 'Sam shipper', '6 - 2PACK', 54, 'X', null]] };
  const before = structuredClone(source);
  const record = parseShippingSheet(source).shippingRecords[0];
  assert.equal(record.values['PIZZAS/CS'], '6 - 2PACK');
  assert.equal(record.shipping.pizzasPerCase, 12);
  assert.equal(record.shipping.packsPerCase, 6);
  assert.equal(record.shipping.pizzasPerPack, 2);
  assert.equal(record.shipping.casesPerPallet, 54);
  assert.equal(record.shipping.key, '["Guide",2]');
  assert.equal(record.shipping.cells[2].column, 3);
  assert.equal(record.shipping.issues.length, 2);
  assert.deepEqual(source, before);
});

test('handles shifted/repeated headers and duplicate labels without overwriting original cells', () => {
  const parsed = parseShippingSheet({ name: 'Shifted', rows: [
    [null, 'PRODUCT', 'SHIPPER', 'PIZZAS/CS', 'CASES', 'NOTE', 'NOTE'],
    [null, 'A', 'Box', 'unknown', -1, 'First', 'Second'],
    [null, 'PRODUCT', 'SHIPPER', 'PIZZAS/CS', 'CASES'],
    [null, 'B', 'Box', 12, 48], [null, 'Footnote only'],
  ] });
  assert.equal(parsed.shippingRecords.length, 2);
  assert.equal(parsed.shippingRecords[0].values['NOTE (column 6)'], 'First');
  assert.equal(parsed.shippingRecords[0].values['NOTE (column 7)'], 'Second');
  assert.equal(parsed.shippingRecords[0].shipping.pizzasPerCase, undefined);
  assert.equal(parsed.shippingRecords[1].shipping.headerRow, 3);
  assert.ok(parsed.notes.some(n => n.includes('Footnote only')));
});

test('one explicit packaging variant can map to a differently named product without changing source labels', () => {
  const parsed = parseOperationalWorkbook(workbook([{ name: 'Guide', rows: [headers,
    ['Lucia carton', '11 shipper', 12, 54], ['Lucia label', '12 shipper', 12, 60],
  ] }]), 'shipping');
  const before = structuredClone(parsed);
  const choices = shippingChoices(parsed);
  const scoped = scopeShippingWorkbook(parsed, choices[1].key, "Lucia's", 'Cheese');
  assert.equal(scoped.sheets[0].shippingRecords.length, 1);
  assert.equal(scoped.sheets[0].shippingRecords[0].brand, 'Lucia label');
  assert.equal(scoped.shippingSelection.targetFlavor, 'Cheese');
  assert.equal(scoped.sheets[0].shippingRecords[0].shipping.casesPerPallet, 60);
  assert.deepEqual(parsed, before);
  assert.throws(() => scopeShippingWorkbook(parsed, 'missing', 'A', 'B'), /Choose a shipping row/);
});

test('all 21 supplied guide variants retain all original populated cells and counts', () => {
  const file = new URL('../../../attached_assets/Shipping_and_Palletizing_Guide_10.12.26_1794437174872.xlsx', import.meta.url);
  const xlsx = XLSX.read(fs.readFileSync(file), { type: 'buffer' });
  const sheets = xlsx.SheetNames.map(name => ({ name, rows: XLSX.utils.sheet_to_json(xlsx.Sheets[name], { header: 1, defval: null }) }));
  const data = parseOperationalWorkbook(workbook(sheets), 'shipping');
  assert.equal(data.title, 'SHIPPING BOXES AND PALLETIZING GUIDE 10/12/2026');
  const choices = shippingChoices(data);
  assert.equal(choices.length, 21);
  assert.equal(new Set(choices.map(c => c.key)).size, 21);
  for (const { sheet, record } of choices) {
    const original = sheets.find(s => s.name === sheet).rows[record.sourceRow - 1];
    assert.equal(record.shipping.cells.length, original.filter(v => v != null && v !== '').length);
    for (const cell of record.shipping.cells) assert.equal(cell.value, original[cell.column - 1]);
    assert.ok(record.shipping.pizzasPerCase > 0);
    assert.ok(record.shipping.casesPerPallet > 0);
  }
  const costco = choices.find(c => c.record.brand.startsWith('Costco')).record;
  assert.equal(costco.shipping.pizzasPerCase, 12);
  assert.equal(costco.shipping.packsPerCase, 4);
  assert.equal(costco.values['PALLET TYPE'], 'Blue');
  assert.equal(costco.values.DIMENSIONS, '24 x 12.125 x 7.375');
  assert.equal(choices.find(c => c.record.brand.startsWith('PriceSmart')).record.shipping.pizzasPerCase, 18);
  assert.equal(choices.filter(c => c.record.brand.startsWith("Lucia's")).length, 4);
});
