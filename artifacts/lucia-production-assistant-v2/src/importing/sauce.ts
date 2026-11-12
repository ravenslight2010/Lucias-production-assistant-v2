import type { OperationalIngredient, OperationalRecipe, OperationalSheet } from './operational';
import type { WorkbookCell, WorkbookSheet } from './workbook';

export type SauceDetails = {
  format: 'lucia.sauce-details.v1';
  referenceOnly: true;
  issues: { code: string; message: string; sourceRows: number[] }[];
};

const text = (v: WorkbookCell | undefined) => typeof v === 'string' ? v.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
const present = (v: WorkbookCell | undefined) => v != null && v !== '';
const numeric = (v: WorkbookCell | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const quantity = (v: WorkbookCell | undefined) => numeric(v) || /^[~≈+-]?\s*\d/.test(text(v));
const unit = (v: string) => /^(?:lbs?\.?|pounds?|oz\.?|qt\.?|quarts?|each|ea\.?|kg\.?)$/i.test(v);
const header = (v: string) => /^(?:ingredients?:?|ingredient|single batch|drum batch|full|half)$/i.test(v) || unit(v);

/** Preserve source formulas as references, never infer conversions or choose an alternative. */
export function reviewSauceSheet(sheet: WorkbookSheet, fallback: OperationalSheet): OperationalSheet {
  const totalRow = sheet.rows.findIndex(row => row.some(v => /^total(?:\s+weight)?$/i.test(text(v))));
  if (!fallback.recipes[0] && totalRow < 0) return fallback;
  const first: OperationalRecipe = fallback.recipes[0] ?? {
    name: sheet.rows.flatMap(row => row.map(text)).find(v => /\bsauce\b/i.test(v)) || sheet.name,
    source: { sheet: sheet.name, startRow: 1, endRow: sheet.rows.length },
    ingredients: [], steps: [], equipment: [], notes: [], metrics: [],
  };
  const issues: SauceDetails['issues'] = [];
  const add = (code: string, message: string, ...sourceRows: number[]) => issues.push({ code, message, sourceRows });
  let recipe: OperationalRecipe = { ...first, notes: [...first.notes], ingredients: first.ingredients.map(i => ({ ...i, amounts: [...i.amounts] })) };

  if (totalRow >= 0) {
    const nameColumn = sheet.rows[totalRow].findIndex(v => /^total(?:\s+weight)?$/i.test(text(v)));
    const columns = sheet.rows[totalRow].flatMap((v, c) => c !== nameColumn && quantity(v) ? [c] : []);
    let start = totalRow;
    while (start > 0) {
      const row = sheet.rows[start - 1];
      const name = text(row[nameColumn]);
      if (!name || header(name)) break;
      start--;
    }
    if (columns.length && start < totalRow) {
      const label = (column: number) => {
        const value = text(sheet.rows[start - 1]?.[column]);
        const size = text(sheet.rows[start - 2]?.[column]);
        return unit(value) && /\b(?:bags?|batch|full|half)\b/i.test(size)
          ? `${size} (${value})` : value || 'Source quantity (unit not stated)';
      };
      const ingredient = (row: number): OperationalIngredient => ({
        name: text(sheet.rows[row][nameColumn]),
        sourceRow: row + 1,
        amounts: columns.filter(c => present(sheet.rows[row][c])).map(c => ({
          column: c + 1, label: label(c), value: sheet.rows[row][c] as string | number | boolean,
        })),
      });
      recipe.ingredients = sheet.rows.slice(start, totalRow).map((_, i) => ingredient(start + i));
      recipe.total = ingredient(totalRow);
      recipe.source = { sheet: sheet.name, startRow: start + 1, endRow: totalRow + 1 };
      for (let r = start; r < totalRow; r++) {
        sheet.rows[r].forEach((v, c) => {
          if (c !== nameColumn && !columns.includes(c) && present(v)) recipe.notes.push(`Row ${r + 1}, column ${c + 1}: ${String(v)}`);
        });
      }
      for (const column of columns) {
        const values = recipe.ingredients.map(i => i.amounts.find(a => a.column === column + 1)?.value);
        const total = recipe.total.amounts.find(a => a.column === column + 1)?.value;
        if (values.some(v => v == null)) add('missing_quantity', `A source quantity is missing in ${label(column)}.`, ...recipe.ingredients.filter(i => !i.amounts.some(a => a.column === column + 1)).map(i => i.sourceRow));
        if ([...values, total].some(v => typeof v === 'string')) {
          add('annotated_quantity', `Keep the annotated quantities in ${label(column)} verbatim; they have not been converted to weights.`, start + 1, totalRow + 1);
        } else if (values.every(numeric) && numeric(total)) {
          const sum = values.reduce((n, v) => n + v, 0);
          if (Math.abs(sum - total) > Math.max(0.01, Math.abs(total) * 1e-8)) add('total_mismatch', `${label(column)} lists total ${total}, but its ingredient sum is ${Number(sum.toFixed(6))}.`, totalRow + 1);
        }
        if ([...values, total].some(v => numeric(v) && v < 0)) add('negative_quantity', 'The source contains a negative quantity; review it without correction.', start + 1, totalRow + 1);
        if (!unit(text(sheet.rows[start - 1]?.[column]))) add('unit_not_stated', `${label(column)} does not state a weight unit. No unit was inferred.`, start);
      }
    }
  } else {
    // Process worksheets may give each ingredient its own native unit, alongside
    // calculated batch weights and ratios. Keep every column, with no conversion.
    const heading = sheet.rows.findIndex(row => row.some(v => /^ingredients?:$/i.test(text(v))));
    const start = heading < 0 ? -1 : sheet.rows.findIndex((row, i) =>
      i > heading && Boolean(text(row[0])) && row.some(numeric) && row.some(v => unit(text(v))),
    );
    if (start >= 0) {
      const quantityColumn = sheet.rows[start].findIndex(numeric);
      const nativeUnitColumn = sheet.rows[start].findIndex((v, c) => c > quantityColumn && unit(text(v)));
      const columns = sheet.rows[start].flatMap((v, c) => numeric(v) ? [c] : []);
      let end = start;
      while (end < sheet.rows.length && text(sheet.rows[end][0]) && !/^process$/i.test(text(sheet.rows[end][0]))) end++;
      recipe.ingredients = sheet.rows.slice(start, end).map((row, i) => ({
        name: text(row[0]), sourceRow: start + i + 1,
        amounts: columns.filter(c => present(row[c])).map(c => ({
          column: c + 1,
          label: c === quantityColumn ? text(row[nativeUnitColumn]) || 'Native unit not stated' : `Source calculation, column ${c + 1} (unit/basis not confirmed)`,
          value: row[c] as string | number | boolean,
        })),
      }));
      recipe.total = undefined;
      recipe.metrics = [{
        name: 'Unlabelled source summary (not a confirmed total)',
        sourceRow: end + 1,
        amounts: columns.filter(c => present(sheet.rows[end]?.[c])).map(c => ({ column: c + 1, label: `Source column ${c + 1}`, value: sheet.rows[end][c] as string | number })),
      }];
      const batchRow = sheet.rows.findIndex(row => row.some(v => /^batches$/i.test(text(v))));
      if (batchRow >= 0) {
        const batchColumn = sheet.rows[batchRow].findIndex(v => /^batches$/i.test(text(v)));
        const batchCountRow = sheet.rows.findIndex((row, i) => i > batchRow && i < start && numeric(row[batchColumn]));
        if (batchCountRow >= 0) recipe.metrics.push({ name: 'Source batch count', sourceRow: batchCountRow + 1, amounts: [{ column: batchColumn + 1, label: 'Batches', value: sheet.rows[batchCountRow][batchColumn] as number }] });
      }
      recipe.source = { sheet: sheet.name, startRow: start + 1, endRow: end };
      add('mixed_units_and_calculations', 'Native units and parallel source calculations are separate references. No pounds, volume, item-count, or ratio conversions were assumed.', start + 1, end + 1);
    }
  }

  // Preserve all non-table source text, including annotations and conditional
  // adjustments; the sparse original source also remains attached on import.
  for (let r = 0; r < sheet.rows.length; r++) {
    if (r + 1 >= recipe.source.startRow && r + 1 <= recipe.source.endRow) continue;
    const cells = sheet.rows[r].flatMap((v, c) => present(v) ? [`Column ${c + 1}: ${String(v)}`] : []);
    if (cells.length) recipe.notes.push(`Row ${r + 1}: ${cells.join(' · ')}`);
  }
  recipe.notes = [...new Set(recipe.notes)];
  const materials = sheet.rows.findIndex(row => /^materials$/i.test(text(row[0])));
  if (materials >= 0) {
    const equipment: string[] = [];
    for (let r = materials + 1; r < sheet.rows.length; r++) {
      const name = text(sheet.rows[r][0]);
      if (!name || header(name)) break;
      equipment.push(name);
    }
    recipe.equipment = equipment;
  }
  const water = recipe.ingredients.find(i => /^water$/i.test(i.name));
  const waterAmount = water?.amounts[0]?.value;
  for (const step of recipe.steps) {
    const amount = step.text.match(/\bset\s+water\s+to\s+(\d+(?:\.\d+)?)/i);
    if (amount && numeric(waterAmount) && Number(amount[1]) !== waterAmount) add('water_instruction_conflict', `Ingredient table lists water ${waterAmount}; source step says ${amount[1]}. Neither value was replaced.`, water!.sourceRow, step.sourceRow);
  }
  const repeated = recipe.steps.filter((step, i, all) => all.findIndex(s => s.order === step.order) !== i);
  if (repeated.length) add('repeated_step_number', 'Source step numbering repeats; the original order and text were retained.', ...repeated.map(s => s.sourceRow));
  const conditionalRows = sheet.rows.flatMap((row, i) => row.some(v => /\b(?:days?\s+prior|day\s+prior|if\s+.*(?:thick|add)|max(?:imum)?\s+batches|must be pulled)\b/i.test(text(v))) ? [i + 1] : []);
  if (conditionalRows.length) add('conditional_adjustment', 'The source includes conditional additions, pull timing, or batch limits. Review the original instructions; no adjustment was applied automatically.', ...conditionalRows);
  if (!recipe.ingredients.length) add('missing_ingredients', 'No complete ingredient table was detected; this is a process reference only.');

  recipe.sauce = { format: 'lucia.sauce-details.v1', referenceOnly: true, issues };
  const recipes = [recipe];
  // Separate tested/untested side experiments from the original procedure.
  const experiment = sheet.rows.findIndex(row => row.some(v => /^tested and$/i.test(text(v))));
  if (experiment >= 0) {
    const testedColumn = sheet.rows[experiment].findIndex(v => /^tested and$/i.test(text(v)));
    const nameColumn = testedColumn - 1;
    const start = sheet.rows.findIndex((row, i) => i > experiment && text(row[nameColumn]) && numeric(row[testedColumn]));
    if (nameColumn >= 0 && start >= 0) {
      let end = start;
      while (end < sheet.rows.length && text(sheet.rows[end][nameColumn])) end++;
      const columns = [...new Set(sheet.rows.slice(start, end).flatMap(row => row.flatMap((v, c) => c > nameColumn && numeric(v) ? [c] : [])))];
      for (const column of columns) {
        const status = `${text(sheet.rows[experiment][column])} ${text(sheet.rows[experiment + 1]?.[column])}`.trim() || 'Unlabelled alternative';
        const ingredients = sheet.rows.slice(start, end).map((row, i) => ({
          name: text(row[nameColumn]), sourceRow: start + i + 1,
          amounts: present(row[column]) ? [{ column: column + 1, label: text(row[column + 1]) || 'Source quantity (unit not stated)', value: row[column] as string | number }] : [],
        }));
        recipes.push({
          name: `${first.name} — ${status} — source column ${column + 1}`,
          source: { sheet: sheet.name, startRow: start + 1, endRow: end },
          ingredients, steps: [], equipment: [], notes: ['Separate source experiment, not an approved replacement. The original procedure has not been assigned to this alternative.'],
          metrics: present(sheet.rows[end]?.[column]) ? [{ name: 'Unlabelled source summary (not a confirmed total)', sourceRow: end + 1, amounts: [{ column: column + 1, label: 'Source value', value: sheet.rows[end][column] as number }] }] : [],
          sauce: { format: 'lucia.sauce-details.v1', referenceOnly: true, issues: [
            { code: 'alternative_reference', message: 'Source experiment retained separately. Its heading is not an approval for production use; no missing quantities or units were inferred.', sourceRows: [experiment + 1, start + 1, end + 1] },
          ] },
        });
      }
      add('parallel_experiments', 'Tested and untested source alternatives are retained as separate reference formulas, not merged into the original procedure.', experiment + 1);
    }
  }
  return { ...fallback, recipes, notes: fallback.notes.filter(note =>
    !(recipe.ingredients.length > 0 && /^(?:No ingredient table|No recipe table or process steps)/.test(note)),
  ) };
}

export function sauceIssueCount(data: { sheets: OperationalSheet[] } | null | undefined) {
  return data?.sheets.reduce((n, s) => n + s.recipes.reduce((m, r) => m + (r.sauce?.issues.length ?? 0), 0), 0) ?? 0;
}
