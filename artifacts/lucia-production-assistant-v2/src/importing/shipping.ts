import type { OperationalShippingRecord, OperationalSheet, OperationalWorkbookData } from './operational';
import type { WorkbookCell, WorkbookSheet } from './workbook';

export type ShippingDetails = {
  format: 'lucia.shipping-details.v1';
  key: string;
  headerRow: number;
  cells: { column: number; label: string; value: string | number | boolean }[];
  pizzasPerCase?: number;
  packsPerCase?: number;
  pizzasPerPack?: number;
  casesPerPallet?: number;
  issues: string[];
};
const text = (v: WorkbookCell | undefined) => typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
const headerKey = (v: WorkbookCell | undefined) => text(v).toUpperCase().replace(/[^A-Z]/g, '');
const count = (v: unknown): number | undefined => {
  if (!/^\d+$/.test(String(v ?? '').trim())) return undefined;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
};

export function parseShippingSheet(sheet: WorkbookSheet): OperationalSheet {
  const shippingRecords: OperationalShippingRecord[] = [];
  let headers: WorkbookCell[] = [], headerRow = 0, brandColumn = -1, boxColumn = -1;
  const notes: string[] = [];
  sheet.rows.forEach((row, index) => {
    const keys = row.map(headerKey);
    const brand = keys.findIndex(k => ['PIZZA', 'PRODUCT', 'BRAND'].includes(k));
    const box = keys.findIndex(k => ['BOX', 'SHIPPER'].includes(k));
    if (brand >= 0 && box >= 0) {
      headers = row; headerRow = index + 1; brandColumn = brand; boxColumn = box;
      return;
    }
    if (!headerRow || !text(row[brandColumn])) return;
    if (!text(row[boxColumn])) {
      notes.push(`Row ${index + 1}: ${text(row[brandColumn])} — no box supplied; retained as a source note, not a shipping row.`);
      return;
    }
    const cells = row.flatMap((value, column) =>
      value == null || value === '' ? [] : [{ column: column + 1, label: text(headers[column]) || `Column ${column + 1}`, value }]);
    const values = Object.fromEntries(cells.map(c => [
      cells.filter(other => other.label === c.label).length > 1 ? `${c.label} (column ${c.column})` : c.label, c.value,
    ]));
    const sourceValue = (match: (k: string) => boolean) => row[headers.map(headerKey).findIndex(match)];
    const rawPizzas = sourceValue(k => k.startsWith('PIZZAS'));
    const multipack = String(rawPizzas ?? '').trim().match(/^(\d+)\s*[-–x×]\s*(\d+)\s*[- ]?\s*(?:pack|pk)s?$/i);
    const packs = multipack ? count(multipack[1]) : undefined;
    const perPack = multipack ? count(multipack[2]) : undefined;
    const product = packs && perPack ? packs * perPack : undefined;
    const pizzasPerCase = product && Number.isSafeInteger(product) ? product : count(rawPizzas);
    const casesPerPallet = count(sourceValue(k => k === 'CASES' || k.startsWith('CASESP')));
    const issues: string[] = [];
    if (!pizzasPerCase) issues.push('Pizzas per case is missing or not a confirmed whole-number/multipack count.');
    if (!casesPerPallet) issues.push('Cases per pallet is missing or not a positive whole number.');
    const grip = String(sourceValue(k => k.startsWith('GRIPSHE')) ?? '').trim();
    if (grip && !/^(n\/?a|none)$/i.test(grip)) issues.push('Grip-sheet marking is preserved; the guide does not specify placement by layer.');
    if (!sourceValue(k => k === 'PALLETHEIGHT')) issues.push('Pallet height is not supplied.');
    shippingRecords.push({
      sourceRow: index + 1, brand: text(row[brandColumn]), values,
      shipping: {
        format: 'lucia.shipping-details.v1', key: JSON.stringify([sheet.name, index + 1]),
        headerRow, cells, pizzasPerCase, casesPerPallet,
        ...(product && Number.isSafeInteger(product) ? { packsPerCase: packs, pizzasPerPack: perPack } : {}),
        issues,
      },
    });
  });
  if (!shippingRecords.length) notes.push('No shipping table with populated product rows was confidently detected.');
  return { name: sheet.name, recipes: [], productMappings: [], shippingRecords, notes };
}

export function shippingChoices(data: OperationalWorkbookData) {
  return data.sheets.flatMap(sheet => sheet.shippingRecords.flatMap(record =>
    record.shipping ? [{ key: record.shipping.key, sheet: sheet.name, record }] : []));
}

/** Explicitly map one packaging variant; never rename the original guide label. */
export function scopeShippingWorkbook(data: OperationalWorkbookData, key: string, brand: string, flavor: string): OperationalWorkbookData {
  const choice = shippingChoices(data).find(c => c.key === key);
  if (!choice) throw new Error('Choose a shipping row from the selected worksheets.');
  return {
    ...data, filteredToBrand: brand,
    shippingSelection: { format: 'lucia.shipping-selection.v1', key, targetBrand: brand, targetFlavor: flavor, reviewed: true },
    sheets: data.sheets.filter(s => s.name === choice.sheet).map(s => ({ ...s, shippingRecords: [choice.record] })),
  };
}
