import type { WorkbookCell, WorkbookSheet } from './workbook';
import type { OperationalIngredient, OperationalRecipe, OperationalSheet, OperationalWorkbookData } from './operational';

export type CheeseDetails = {
  format: 'lucia.cheese-details.v1';
  key: string;
  brand: string;
  sourceName: string;
  headerRow: number;
  sourceColumn: number;
  applicator: string | null;
  ingredientSum: number | null;
  issues: { code: string; message: string; sourceRows: number[] }[];
};
export type CheeseSelection = { keys: string[]; reviewedAsReference: boolean };

const text = (value: WorkbookCell | undefined) =>
  typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
const pounds = (value: WorkbookCell | undefined) => /^lbs?\.?$/i.test(text(value));
const numeric = (value: WorkbookCell | undefined): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(?:\([^)]*\))?$/);
  return match && Number.isFinite(Number(match[1])) ? Number(match[1]) : null;
};
const blank = (value: WorkbookCell | undefined) => value == null || (typeof value === 'string' && !value.trim());

function heading(sheet: WorkbookSheet, header: number, column: number) {
  let applicator: string | null = null;
  for (let r = header; r >= Math.max(0, header - 4); r--) {
    const label = text(sheet.rows[r]?.[column - 1]);
    if (!label || /^(?:ingredients?|lbs?\.?)$/i.test(label)) continue;
    if (/^for\s+\d+(?:st|nd|rd|th)\s+cheese applicator/i.test(label)) {
      applicator = label;
      continue;
    }
    // A weight/total above a new LBS header means a percentage block, not a recipe.
    if (numeric(sheet.rows[r]?.[column]) !== null || /^(?:total|percent|cellulose|note|cheese shredder)\b/i.test(label) || label.includes(':')) return null;
    return { name: label, applicator, row: r };
  }
  return null;
}

export function parseCheeseSheet(sheet: WorkbookSheet): OperationalSheet {
  const recipes: OperationalRecipe[] = [];
  const consumed = new Set<number>();
  for (let h = 0; h < sheet.rows.length; h++) {
    for (let column = 1; column < sheet.rows[h].length; column++) {
      if (!pounds(sheet.rows[h][column])) continue;
      const title = heading(sheet, h, column);
      if (!title) continue;
      const ingredients: OperationalIngredient[] = [];
      let total: OperationalIngredient | undefined;
      let end = h;
      const issues: CheeseDetails['issues'] = [];
      const amount = (r: number) => {
        const value = sheet.rows[r]?.[column];
        return typeof value === 'number' || (typeof value === 'string' && value.trim())
          ? [{ column: column + 1, label: 'LBS', value }] : [];
      };
      for (let r = h + 1; r < Math.min(sheet.rows.length, h + 100); r++) {
        const label = text(sheet.rows[r][column - 1]);
        const weight = sheet.rows[r][column];
        if (pounds(weight) || /^percent\b/i.test(label)) break;
        if (!label && blank(weight)) continue;
        if (/^total\b/i.test(label) || (!label && numeric(weight) !== null && ingredients.length > 0)) {
          total = { name: label || 'Unlabelled total', sourceRow: r + 1, amounts: amount(r) };
          if (!label) issues.push({ code: 'unlabelled_total', message: 'A weight without a label was retained as a possible total. Confirm its meaning.', sourceRows: [r + 1] });
          end = r;
          consumed.add(r);
          break;
        }
        if (!label) continue;
        if (pounds(sheet.rows[r + 1]?.[column])) break;
        ingredients.push({ name: label, sourceRow: r + 1, amounts: amount(r) });
        consumed.add(r);
        end = r;
        if (numeric(weight) === null) issues.push({ code: 'missing_weight', message: `${label}: the source does not supply an unambiguous pound weight.`, sourceRows: [r + 1] });
        else if (numeric(weight)! < 0) issues.push({ code: 'invalid_weight', message: `${label}: the source contains a negative weight. Review it before use.`, sourceRows: [r + 1] });
        else if (typeof weight === 'string') issues.push({ code: 'annotated_weight', message: `${label}: annotated weight “${weight.trim()}” was retained verbatim. Confirm the pound quantity and annotation.`, sourceRows: [r + 1] });
        if (/\b(?:mix|blend)\b/i.test(label)) issues.push({ code: 'submix_reference', message: `${label} is a source ingredient reference. Select its preparation formula separately if required; it is not automatically substituted or expanded.`, sourceRows: [r + 1] });
      }
      if (!ingredients.length) continue;
      const values = ingredients.map(i => numeric(i.amounts[0]?.value));
      const ingredientSum = values.every(v => v !== null) ? values.reduce<number>((sum, v) => sum + (v ?? 0), 0) : null;
      const totalValue = numeric(total?.amounts[0]?.value);
      if (totalValue === null) issues.push({ code: 'missing_total', message: 'The source has no unambiguous total weight; no total was invented.', sourceRows: [total?.sourceRow ?? h + 1] });
      else if (ingredientSum !== null && Math.abs(totalValue - ingredientSum) > 0.011) issues.push({
        code: 'total_mismatch', message: `Listed total ${totalValue} lb differs from ingredient sum ${Number(ingredientSum.toFixed(6))} lb. Source values have not been corrected.`,
        sourceRows: [total!.sourceRow],
      });
      const metrics: OperationalIngredient[] = [];
      if (total) for (let r = end + 1; r < Math.min(sheet.rows.length, end + 8); r++) {
        const label = text(sheet.rows[r][column - 1]);
        if (!label) continue;
        if (!/^(?:cellulose|percent)\b/i.test(label)) break;
        metrics.push({ name: label, sourceRow: r + 1, amounts: amount(r).map(a => ({ ...a, label: /^percent/i.test(label) ? 'Source percent' : 'LBS' })) });
        consumed.add(r);
      }
      const cellulose = metrics.find(metric => /^cellulose$/i.test(metric.name));
      const percent = metrics.find(metric => /^percent$/i.test(metric.name));
      const celluloseWeight = numeric(cellulose?.amounts[0]?.value);
      const printedPercent = numeric(percent?.amounts[0]?.value);
      if (celluloseWeight !== null && printedPercent !== null && totalValue !== null && totalValue > 0 &&
          Math.abs(celluloseWeight / totalValue * 100 - printedPercent) > 0.1) {
        issues.push({
          code: 'percent_basis_review',
          message: `Printed cellulose percent ${printedPercent} differs from the cellulose-weight / listed-total comparison (${Number((celluloseWeight / totalValue * 100).toFixed(4))}%). Verify the source basis; no percentage was replaced.`,
          sourceRows: [cellulose!.sourceRow, percent!.sourceRow, total!.sourceRow],
        });
      }
      consumed.add(h);
      consumed.add(title.row);
      recipes.push({
        name: `${sheet.name} — ${title.name}`,
        source: { sheet: sheet.name, startRow: h + 2, endRow: end + 1 },
        ingredients, ...(total ? { total } : {}), metrics,
        steps: [], equipment: [], notes: [],
        cheese: {
          format: 'lucia.cheese-details.v1',
          key: JSON.stringify([sheet.name, h + 1, column + 1]),
          brand: sheet.name, sourceName: title.name, headerRow: h + 1, sourceColumn: column + 1,
          applicator: title.applicator, ingredientSum, issues,
        },
      });
    }
  }
  const firstHeader = Math.min(...recipes.map(r => r.cheese!.headerRow), sheet.rows.length + 1) - 1;
  const productMappings: OperationalSheet['productMappings'] = [];
  for (let r = 0; r < firstHeader; r++) for (const value of sheet.rows[r]) {
    const label = text(value);
    if (/note|shredder|setting|^take |^multiply |^example/i.test(label)) continue;
    const match = label.match(/^([^:]+):\s*(.+)$/);
    if (match) productMappings.push({ sourceRow: r + 1, product: match[1].trim(), recipe: match[2].trim() });
  }
  const notes = sheet.rows.flatMap((row, r) => {
    if (consumed.has(r)) return [];
    const joined = row.map(text).filter(value => value && !/^lbs?\.?$/i.test(value)).join(' · ');
    return joined ? [`Row ${r + 1}: ${joined}`] : [];
  });
  if (!recipes.length) notes.unshift(`No complete cheese-mix tables were confidently detected in worksheet "${sheet.name}".`);
  return { name: sheet.name, recipes, productMappings, shippingRecords: [], notes };
}

export function cheeseRecipeChoices(data: OperationalWorkbookData | null) {
  return data?.importKind === 'cheese' ? data.sheets.flatMap(sheet =>
    sheet.recipes.flatMap(recipe => recipe.cheese ? [{ key: recipe.cheese.key, recipe, sheet: sheet.name }] : []),
  ) : [];
}

export function scopeCheeseWorkbook(data: OperationalWorkbookData, keys: string[], reviewedAsReference = false): OperationalWorkbookData {
  const choices = cheeseRecipeChoices(data);
  const selected = new Set(keys);
  if (!keys.length || keys.length > 100 || selected.size !== keys.length || keys.some(key => !choices.some(c => c.key === key))) {
    throw new Error('Choose valid cheese recipes from the current customer worksheet.');
  }
  const sheets = data.sheets.map(sheet => ({
    ...sheet, recipes: sheet.recipes.filter(recipe => recipe.cheese && selected.has(recipe.cheese.key)),
  })).filter(sheet => sheet.recipes.length);
  if (sheets.length !== 1) throw new Error('Choose cheese recipes from only one customer worksheet per profile.');
  return { ...data, sheets, selectedSheetNames: sheets.map(s => s.name), cheeseSelection: { keys: [...keys].sort(), reviewedAsReference } };
}
