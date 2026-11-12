import type { ParsedWorkbook, WorkbookCell, WorkbookSheet } from './workbook';
import type { OperationalRecipe, OperationalWorkbookData } from './operational';

export type DoughPortion = {
  product: string;
  sourceRow: number;
  ounces: number | null;
  pounds: number | null;
  yield: number | null;
  perTray: number | null;
};
export type DoughBatch = {
  column: number;
  label: string;
  unit: string | null;
  total: number | null;
  ingredientSum: number | null;
};
export type DoughReviewIssue = {
  code: string;
  message: string;
  sourceRows: number[];
};
export type DoughDetails = {
  format: 'lucia.dough-details.v1';
  portions: DoughPortion[];
  batches: DoughBatch[];
  issues: DoughReviewIssue[];
  headerRow: number;
  selection?: { batchColumn: number; portionSourceRow: number; reviewedAsReference: boolean };
};

const text = (value: WorkbookCell | undefined) =>
  typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
const number = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return typeof value === 'string' && /^[-+]?\d+(?:\.\d+)?$/.test(value.trim())
    ? Number(value.trim()) : null;
};
const rounded = (value: number) => Number(value.toFixed(6));
const ingredientKey = (value: string) => value.toLowerCase()
  .replace(/[‘’]/g, "'").replace(/\bufi[-\s]*u\d+\b/g, '')
  .replace(/\bfresh compressed\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export function extractDoughPortions(sheet: WorkbookSheet): DoughPortion[] {
  const portions: DoughPortion[] = [];
  for (let index = 0; index < sheet.rows.length; index++) {
    const headers = sheet.rows[index].map(text);
    const yieldColumn = headers.findIndex(value => /^yield$/i.test(value));
    const trayColumn = headers.findIndex(value => /^per\s+tray$/i.test(value));
    const ozColumn = headers.findIndex(value => /^oz\.?$/i.test(value));
    const lbColumn = headers.findIndex(value => /^lbs?\.?$/i.test(value));
    if (yieldColumn < 0 || trayColumn < 0 || ozColumn < 0) continue;
    for (let rowIndex = index + 1; rowIndex < sheet.rows.length; rowIndex++) {
      const row = sheet.rows[rowIndex];
      const product = row.slice(0, ozColumn).map(text).filter(Boolean).join(' ');
      if (!product || number(row[ozColumn]) === null) break;
      portions.push({
        product, sourceRow: rowIndex + 1,
        ounces: number(row[ozColumn]),
        pounds: lbColumn >= 0 ? number(row[lbColumn]) : null,
        yield: number(row[yieldColumn]), perTray: number(row[trayColumn]),
      });
    }
  }
  return portions;
}

export function extractDoughDetails(
  sheet: WorkbookSheet,
  recipe: OperationalRecipe,
  headerRow: number,
): DoughDetails {
  const issues: DoughReviewIssue[] = [];
  const add = (code: string, message: string, sourceRows: number[]) =>
    issues.push({ code, message, sourceRows });
  const allAmounts = [...recipe.ingredients, ...(recipe.total ? [recipe.total] : [])].flatMap(item => item.amounts);
  const unit = sheet.rows[headerRow]?.map(text).find(value => /^(?:lbs?\.?|pounds?|oz\.?|ounces?|kgs?|grams?)$/i.test(value)) ?? null;
  const columns = [...new Set(allAmounts.map(amount => amount.column))];
  const batches: DoughBatch[] = columns.map(column => {
    const amounts = recipe.ingredients.map(item => item.amounts.find(amount => amount.column === column));
    const values = amounts.map(amount => number(amount?.value));
    const ingredientSum = values.every(value => value !== null)
      ? rounded(values.reduce<number>((sum, value) => sum + (value ?? 0), 0)) : null;
    const totalAmount = recipe.total?.amounts.find(amount => amount.column === column);
    const label = allAmounts.find(amount => amount.column === column)?.label ?? `Column ${column}`;
    const total = number(totalAmount?.value);
    if (/^column \d+$/i.test(label)) {
      add('unlabeled_batch', `Column ${column} has amounts but no batch label or unit. Do not assume what this column represents.`, [headerRow + 1]);
    }
    if (total !== null && ingredientSum !== null && Math.abs(total - ingredientSum) > 0.01) {
      add('total_mismatch', `${label}: ingredient sum ${ingredientSum} differs from the listed total ${total}. Source values were not corrected.`, [recipe.total!.sourceRow]);
    }
    return { column, label, unit: /^column \d+$/i.test(label) ? null : unit, total, ingredientSum };
  });
  for (const ingredient of recipe.ingredients) {
    const missingColumns = columns.filter(column => !ingredient.amounts.some(amount =>
      amount.column === column && number(amount.value) !== null,
    ));
    if (missingColumns.length) add('missing_amount',
      `${ingredient.name} has no numeric weight in column${missingColumns.length === 1 ? '' : 's'} ${missingColumns.join(', ')}. It was kept, not dropped.`,
      [ingredient.sourceRow]);
  }
  if (batches.length > 1) add('multiple_batches',
    'Multiple quantity columns are present. Select the intended batch column before applying this dough to a product.',
    [headerRow + 1]);

  const seenSteps = new Set<number>();
  let previousStep = 0;
  for (const step of recipe.steps) {
    if (seenSteps.has(step.order) || step.order <= previousStep) add('step_numbering',
      `Source step ${step.order} repeats or is out of order. The procedure stays in worksheet order.`, [step.sourceRow]);
    seenSteps.add(step.order);
    previousStep = step.order;
    // These are conservative comparisons, not recipe corrections or unit conversions.
    const water = step.text.match(/\bset\s+water\s+to\s+(\d+(?:\.\d+)?)\s*lbs?\b/i);
    const checks: Array<{ value: number; name: string }> = water ? [{ value: Number(water[1]), name: 'water' }] : [];
    const mentions = [...step.text.matchAll(/(\d+(?:\.\d+)?)\s*(?:lbs?\.?|pounds?)\b/gi)];
    mentions.forEach((mention, index) => {
      const start = mention.index ?? 0;
      if (/\d+\s*-\s*$/.test(step.text.slice(0, start))) return; // a bag size, not batch weight
      const remainder = step.text.slice(start + mention[0].length, mentions[index + 1]?.index ?? step.text.length)
        .replace(/^\s*(?:\([^)]*\)\s*)?(?:of\s+)?/i, '');
      checks.push({ value: Number(mention[1]), name: ingredientKey(remainder) });
    });
    for (const ingredient of recipe.ingredients) {
      const key = ingredientKey(ingredient.name);
      const weights = ingredient.amounts.filter(amount => batches.find(batch =>
        batch.column === amount.column && batch.unit && /^(?:lbs?\.?|pounds?)$/i.test(batch.unit),
      )).map(amount => number(amount.value)).filter((value): value is number => value !== null);
      if (!weights.length || !key) continue;
      const conflict = checks.find(check =>
        (check.name === key || check.name.startsWith(`${key} `)) &&
        !weights.some(weight => Math.abs(weight - check.value) <= 0.01),
      );
      if (conflict) add('instruction_quantity_conflict',
        `${ingredient.name}: instruction says ${conflict.value} lb, but the table lists ${weights.join(' / ')} lb. Review the source before use.`,
        [ingredient.sourceRow, step.sourceRow]);
    }
  }

  const portions = extractDoughPortions(sheet);
  if (!portions.length) add('missing_portions', 'No dough-ball weight / yield / per-tray table was confidently detected.', []);
  for (const portion of portions) {
    if (portion.ounces !== null && portion.pounds !== null && Math.abs(portion.ounces / 16 - portion.pounds) > 0.011) {
      add('portion_weight_conflict', `${portion.product}: the listed ounce and pound dough-ball weights disagree. Neither was changed.`, [portion.sourceRow]);
    }
  }
  return { format: 'lucia.dough-details.v1', portions, batches, issues, headerRow: headerRow + 1 };
}

export function doughPortionChoices(data: OperationalWorkbookData | null) {
  if (data?.importKind !== 'dough_guide') return [];
  return data.sheets.flatMap(sheet => sheet.recipes.flatMap(recipe =>
    (recipe.dough?.portions ?? []).map(portion => ({
      key: JSON.stringify([sheet.name, portion.sourceRow]),
      sheet: sheet.name,
      portion,
      batches: recipe.dough?.batches ?? [],
    })),
  ));
}

export function scopeDoughWorkbook(
  workbook: ParsedWorkbook,
  data: OperationalWorkbookData,
  portionKey: string,
  batchColumn: number,
  reviewedAsReference = false,
): OperationalWorkbookData {
  const choice = doughPortionChoices(data).find(item => item.key === portionKey);
  if (!choice || !choice.batches.some(batch => batch.column === batchColumn)) {
    throw new Error('Choose a valid dough-ball variant and batch column from this workbook.');
  }
  const sourceSheet = workbook.sheets.find(sheet => sheet.name === choice.sheet);
  if (!sourceSheet) throw new Error('The selected dough worksheet is no longer available.');
  const sheets = data.sheets.filter(sheet => sheet.name === choice.sheet).map(sheet => ({
    ...sheet,
    recipes: sheet.recipes.filter(recipe => recipe.dough?.portions.some(portion =>
      portion.sourceRow === choice.portion.sourceRow,
    )).map(recipe => {
      const scoped: OperationalRecipe = {
        ...recipe,
        ingredients: recipe.ingredients.map(ingredient => ({
          ...ingredient, amounts: ingredient.amounts.filter(amount => amount.column === batchColumn),
        })),
        ...(recipe.total ? { total: {
          ...recipe.total, amounts: recipe.total.amounts.filter(amount => amount.column === batchColumn),
        } } : {}),
      };
      const details = extractDoughDetails(sourceSheet, scoped, recipe.dough!.headerRow - 1);
      scoped.dough = {
        ...details,
        portions: [choice.portion],
        issues: details.issues.filter(issue =>
          issue.code !== 'portion_weight_conflict' || issue.sourceRows.includes(choice.portion.sourceRow),
        ),
        selection: { batchColumn, portionSourceRow: choice.portion.sourceRow, reviewedAsReference },
      };
      return scoped;
    }),
  }));
  return { ...data, sheets };
}
