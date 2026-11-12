import type { WorkbookCell, WorkbookSheet } from './workbook';
import type { OperationalAmount, OperationalIngredient, OperationalRecipe, OperationalSheet, OperationalWorkbookData } from './operational';

export type PremixDetails = {
  format: 'lucia.premix-details.v1';
  key: string;
  sourceBrand: string;
  originalName: string;
  referenceOnly: true;
  section: 'mix' | 'preparation';
  pullInstructions: { text: string; sourceRow: number; sourceColumn: number; daysEarly?: number }[];
  sourceRows: { sourceRow: number; cells: { column: number; value: string | number | boolean }[] }[];
  issues: { code: string; message: string; sourceRows: number[] }[];
};

const text = (v: WorkbookCell | undefined) => typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '';
const filled = (v: WorkbookCell | undefined): v is string | number | boolean => v !== undefined && v !== null && v !== '';
const brands = ['Corner Booth', 'Price Chopper', 'Nob Hill', 'Hannaford', 'Lucias', 'Lowes', 'Bobos', 'Basha', 'Mauros', 'FSD', 'SMD'];
const normalized = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
const brandFor = (name: string) => brands.find(b => normalized(name).startsWith(normalized(b))) ?? name.trim();
const instruction = (s: string) => /days?\s+(?:early|prior)|allergen|sticker|don't|don’t|freeze|made in this order|^(?:pull|drain|add|mix|save)\b/i.test(s.replace(/^\W+/, ''));
const metric = (s: string) => /^(?:total\s+(?:cases|amount|amoutn)|cases needed|amount\b|target\b|max batches|pull to drain)/i.test(s);
const exactTotal = (s: string) => /^(?:total|total weight|batch total)$/i.test(s);

/** Table-local quantities and source statements, never recomputed production formulas. */
export function parsePremixSheet(sheet: WorkbookSheet): OperationalSheet {
  const headers: { row: number; start: number; batch: number; end: number }[] = [];
  sheet.rows.forEach((row, r) => row.forEach((v, c) => {
    if (/per\s+batch/i.test(text(v)) && /per\s+pizza/i.test(text(row[c - 1])) && c >= 2) {
      const start = c - 2;
      const nextHeader = row.findIndex((value, col) => col > c && /per\s+pizza/i.test(text(value)));
      headers.push({ row: r, start, batch: c, end: nextHeader >= 0 ? nextHeader - 2 : Math.min(row.length - 1, c + 1) });
    }
  }));
  const recipes: OperationalRecipe[] = [];
  for (const h of headers) {
    const next = headers.find(other => other.start === h.start && other.row > h.row);
    const endRow = next ? Math.max(h.row + 1, next.row - 1) : sheet.rows.length;
    const local = (row: number) => (sheet.rows[row] ?? []).slice(h.start, h.end + 1);
    const cells = (row: number) => local(row).flatMap((v, i) => filled(v) ? [{ column: h.start + i + 1, value: v }] : []);
    const localText = (row: number) => local(row).map(text).filter(Boolean).join(' · ');
    const heading = text(sheet.rows[h.row - 1]?.[h.start]);
    const preparation = instruction(heading);
    const firstLabel = text(sheet.rows[h.row + 1]?.[h.start]);
    const originalName = heading && !preparation ? heading : preparation
      ? `${firstLabel || 'Ingredients'} — preparation` : sheet.name;
    const sourceBrand = brandFor(sheet.name);
    const name = normalized(originalName).startsWith(normalized(sourceBrand)) ? originalName : `${sourceBrand} — ${originalName}`;
    const details: PremixDetails = {
      format: 'lucia.premix-details.v1', key: JSON.stringify([sheet.name, h.row + 1, h.start + 1]),
      sourceBrand, originalName, referenceOnly: true, section: preparation ? 'preparation' : 'mix',
      pullInstructions: [], sourceRows: [], issues: [],
    };
    const issue = (code: string, message: string, rows: number[]) => details.issues.push({ code, message, sourceRows: rows });
    if (brands.includes(sourceBrand) && brands.some(b => b !== sourceBrand && normalized(originalName).startsWith(normalized(b)))) {
      issue('brand_heading_conflict', `Worksheet customer "${sourceBrand}" differs from source heading "${originalName}". No cross-brand merge was applied.`, [h.row]);
    }
    const ingredients: OperationalIngredient[] = [], metrics: OperationalIngredient[] = [], notes: string[] = [];
    const steps: OperationalRecipe['steps'] = [];
    let total: OperationalIngredient | undefined;
    let inIngredients = true, inPull = false;
    // Numbers below the formula are saved source planning values, not current-run requirements.
    const amounts = (r: number, formula: boolean): OperationalAmount[] => {
      const row = sheet.rows[r] ?? [];
      const result: OperationalAmount[] = [];
      for (let c = h.start + 1; c <= h.end; c++) {
        const value = row[c];
        if (!filled(value)) continue;
        let label = formula ? text(sheet.rows[h.row]?.[c]) : '';
        if (!formula) {
          const unit = row[c + 1];
          label = typeof value === 'number' && typeof unit === 'string' ? `Source amount (${text(unit)})` : 'Source value (unit not stated)';
        }
        result.push({ column: c + 1, label: label || 'Source value (unit not stated)', value });
      }
      return result;
    };
    for (let r = Math.max(0, h.row - 1); r < endRow; r++) {
      const sourceCells = cells(r);
      if (!sourceCells.length) continue;
      details.sourceRows.push({ sourceRow: r + 1, cells: sourceCells });
      const statement = localText(r);
      if (instruction(statement)) {
        notes.push(`Row ${r + 1}: ${statement}`);
        if (/\bpull\b/i.test(statement) && !/^pull for mix$/i.test(statement)) {
          const days = statement.match(/(\d+)\s*days?\s*(?:early|prior)/i);
          details.pullInstructions.push({ text: statement, sourceRow: r + 1, sourceColumn: h.start + 1, ...(days ? { daysEarly: Number(days[1]) } : {}) });
        }
        if (/^(?:add|mix|save)\b/i.test(statement)) steps.push({ order: steps.length + 1, sourceRow: r + 1, text: statement });
      }
      if (r <= h.row) continue;
      const label = text(sheet.rows[r]?.[h.start]);
      if (/^pull for mix$/i.test(label)) { inIngredients = false; inPull = true; continue; }
      if (metric(label)) {
        inIngredients = false;
        metrics.push({ name: label, sourceRow: r + 1, amounts: amounts(r, false) });
        continue;
      }
      if (inIngredients && exactTotal(label)) {
        total = { name: label, sourceRow: r + 1, amounts: amounts(r, true) };
        inIngredients = false;
        continue;
      }
      if (instruction(label)) { inIngredients = false; continue; }
      const hasQuantity = [h.start + 1, h.batch].some(c => filled(sheet.rows[r]?.[c]));
      if (inIngredients && label && hasQuantity) {
        const values = amounts(r, true);
        ingredients.push({ name: label, sourceRow: r + 1, amounts: values });
        if (!filled(sheet.rows[r]?.[h.start + 1]) || !filled(sheet.rows[r]?.[h.batch])) {
          issue('incomplete_quantity', `Ingredient "${label}" has no quantity for every formula column. Values were not filled in.`, [r + 1]);
        }
      } else if (!inIngredients && (label || hasQuantity) && !instruction(statement)) {
        metrics.push({ name: `${inPull ? 'Pull: ' : ''}${label || 'Unlabelled source row'}`, sourceRow: r + 1, amounts: amounts(r, false) });
      }
    }
    // Header counts and pull timing are retained independently of ingredient weights.
    const countHeading = text(sheet.rows[h.row - 1]?.[h.batch + 1]);
    const count = sheet.rows[h.row]?.[h.batch + 1];
    if (/mixes/i.test(countHeading) && filled(count)) metrics.unshift({
      name: countHeading, sourceRow: h.row + 1,
      amounts: [{ column: h.batch + 2, label: 'Source workbook mix count (not a current run calculation)', value: count }],
    });
    // Do not misclassify the adjacent source mix-count column as a formula quantity.
    if (/mixes/i.test(countHeading)) {
      for (const item of [...ingredients, ...(total ? [total] : [])]) item.amounts = item.amounts.filter(a => a.column !== h.batch + 2);
    }
    if (!ingredients.length) continue;
    if (total) {
      for (const c of [h.start + 1, h.batch]) {
        const sourceTotal = sheet.rows[total.sourceRow - 1]?.[c];
        const numbers = ingredients.map(i => sheet.rows[i.sourceRow - 1]?.[c]);
        if (typeof sourceTotal === 'number' && numbers.every(n => typeof n === 'number')) {
          const sum = (numbers as number[]).reduce((a, b) => a + b, 0);
          if (Math.abs(sum - sourceTotal) > Math.max(0.001, Math.abs(sourceTotal) * 0.00001)) {
            issue('total_mismatch', `${text(sheet.rows[h.row]?.[c])}: ingredient sum ${Number(sum.toFixed(6))} differs from source total ${sourceTotal}. Neither value was changed.`, [total.sourceRow]);
          }
        }
      }
    }
    if (!total && !preparation) issue('no_formula_total', 'No formula total was supplied. Preparation-only rows and source quantities have not been converted into a complete formula.', [h.row + 1]);
    issue('source_planning_values', 'Mix counts, cases, already-made amounts, and pull totals are saved workbook planning values, not automatically recalculated for the current run.', [h.row + 1]);
    recipes.push({ name, source: { sheet: sheet.name, startRow: h.row + 1, endRow: details.sourceRows.at(-1)?.sourceRow ?? h.row + 1 },
      ingredients, ...(total ? { total } : {}), steps, equipment: [], notes, metrics, premix: details });
  }
  return { name: sheet.name, recipes, productMappings: [], shippingRecords: [],
    notes: recipes.length ? [] : [`No per-pizza/per-batch mix tables were confidently detected in worksheet "${sheet.name}".`] };
}

export const premixIssueCount = (data: OperationalWorkbookData | null | undefined) =>
  data?.sheets.reduce((sum, s) => sum + s.recipes.reduce((n, r) => n + (r.premix?.issues.length ?? 0), 0), 0) ?? 0;
