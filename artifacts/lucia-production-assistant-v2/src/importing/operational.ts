import type { ImportKind, ParsedWorkbook, WorkbookCell, WorkbookSheet } from './workbook';
import { extractDoughDetails } from './dough.ts';
import type { DoughDetails } from './dough';
import { parseCheeseSheet } from './cheese.ts';
import type { CheeseDetails, CheeseSelection } from './cheese';
import { reviewSauceSheet } from './sauce.ts';
import type { SauceDetails } from './sauce';
import { parsePremixSheet } from './premix.ts';
import type { PremixDetails } from './premix';
import { parseShippingSheet } from './shipping.ts';
import type { ShippingDetails } from './shipping';

export type OperationalImportKind = Exclude<ImportKind, 'product_specs' | 'schedule'>;

export type OperationalValue = string | number | boolean;
export type OperationalAmount = {
  column: number;
  label: string;
  value: OperationalValue;
};
export type OperationalIngredient = {
  name: string;
  sourceRow: number;
  amounts: OperationalAmount[];
};
export type OperationalStep = {
  order: number;
  sourceRow: number;
  text: string;
};
export type OperationalRecipe = {
  name: string;
  source: { sheet: string; startRow: number; endRow: number };
  ingredients: OperationalIngredient[];
  total?: OperationalIngredient;
  steps: OperationalStep[];
  equipment: string[];
  notes: string[];
  metrics: OperationalIngredient[];
  dough?: DoughDetails;
  cheese?: CheeseDetails;
  sauce?: SauceDetails;
  premix?: PremixDetails;
};
export type OperationalProductMapping = {
  sourceRow: number;
  product: string;
  recipe: string;
};
export type OperationalShippingRecord = {
  sourceRow: number;
  brand: string;
  values: Record<string, OperationalValue>;
  shipping?: ShippingDetails;
};
export type OperationalSheet = {
  name: string;
  recipes: OperationalRecipe[];
  productMappings: OperationalProductMapping[];
  shippingRecords: OperationalShippingRecord[];
  notes: string[];
};
export type OperationalWorkbookData = {
  format: 'lucia.operational-workbook.v1';
  importKind: OperationalImportKind;
  title: string;
  revision: string | null;
  filteredToBrand?: string;
  availableSheetNames: string[];
  selectedSheetNames: string[];
  sheets: OperationalSheet[];
  warnings: string[];
  cheeseSelection?: CheeseSelection;
  sauceReview?: { reviewedAsReference: boolean };
  premixReview?: { reviewedAsReference: boolean };
  shippingSelection?: { format: 'lucia.shipping-selection.v1'; key: string; targetBrand: string; targetFlavor: string; reviewed: boolean };
};

const normalizeText = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ');
const isBlank = (value: WorkbookCell | undefined) => value == null || value === '';
const isUnit = (value: string) => /^(?:lbs?\.?|pounds?|oz\.?|ounces?|kgs?|grams?|qt\.?|quarts?|each|ea\.?)$/i.test(value.trim());
const isTotal = (value: string) => /^(?:total(?:\s+weight)?|batch\s+total|yield)\b/i.test(value.trim());
const isNumeric = (value: WorkbookCell | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);

function cellText(value: WorkbookCell | undefined) {
  return typeof value === 'string' ? normalizeText(value) : '';
}

function rowStrings(row: WorkbookCell[]) {
  return row.map(cellText).filter(Boolean);
}

function firstCellText(row: WorkbookCell[]) {
  return row.map(cellText).find(Boolean) ?? '';
}

function textRows(sheet: WorkbookSheet) {
  return sheet.rows.map((row, index) => ({
    index,
    text: rowStrings(row).join(' · '),
    cells: row.map((value, column) => ({ value, column })).filter(({ value }) => !isBlank(value)),
  })).filter((row) => row.text);
}

function titleAndRevision(workbook: ParsedWorkbook, sheet: WorkbookSheet, scanAllRevisions = false) {
  const rows = sheet.rows.slice(0, 8);
  const allText = rows.flatMap(rowStrings);
  const title = allText.find((text) =>
    !/^(?:per\s+pizza|per\s+batch|ingredients?|lbs?|oz\.?)\b/i.test(text) &&
    /(?:\bpremix\b|\b(?:dough|sauce|cheese|mix|recipe|pizza)\b)/i.test(text),
  )
    ?? allText[0]
    ?? sheet.name
    ?? workbook.fileName;
  const revisionText = (scanAllRevisions ? sheet.rows.flatMap(rowStrings) : allText)
    .find((text) => /\brev(?:ision)?\.?\s*[#:-]?\s*[a-z0-9.]+/i.test(text));
  const revision = revisionText?.match(/\brev(?:ision)?\.?\s*[#:-]?\s*([a-z0-9.]+)/i)?.[1] ?? null;
  return { title, revision };
}

function headerLabel(sheet: WorkbookSheet, headerRow: number, column: number) {
  for (let rowIndex = headerRow; rowIndex >= Math.max(0, headerRow - 2); rowIndex--) {
    const label = cellText(sheet.rows[rowIndex]?.[column]);
    if (label && isUnit(label)) return label;
    if (label) return label;
  }
  return `Column ${column + 1}`;
}

function amountCells(sheet: WorkbookSheet, rowIndex: number, nameColumn: number, headerRow: number, includeAmountsBeforeName = false): OperationalAmount[] {
  const row = sheet.rows[rowIndex] ?? [];
  const amounts: OperationalAmount[] = [];
  for (let column = includeAmountsBeforeName ? 0 : nameColumn + 1; column < row.length; column++) {
    if (column === nameColumn) continue;
    const value = row[column];
    if (isNumeric(value) || (typeof value === 'string' && /^[-+]?\d+(?:\.\d+)?%?$/.test(value.trim()))) {
      amounts.push({ column: column + 1, label: headerLabel(sheet, headerRow, column), value });
    }
  }
  return amounts;
}

function ingredientName(row: WorkbookCell[], nameColumn: number) {
  for (let column = nameColumn; column < row.length; column++) {
    const text = cellText(row[column]);
    if (text && !isUnit(text)) return text;
  }
  return '';
}

function findGeneralIngredientTable(sheet: WorkbookSheet, preserveUnquantified = false) {
  for (let headerRow = 0; headerRow < sheet.rows.length; headerRow++) {
    const header = rowStrings(sheet.rows[headerRow]).join(' ').toLowerCase();
    const isIngredientHeader = /\bingredients?\b/.test(header) || sheet.rows[headerRow].some((value) => isUnit(cellText(value)));
    if (!isIngredientHeader) continue;

    let tableHeaderRow = headerRow;
    for (let rowIndex = headerRow; rowIndex < Math.min(sheet.rows.length, headerRow + 6); rowIndex++) {
      if (sheet.rows[rowIndex].some((value) => isUnit(cellText(value)))) {
        tableHeaderRow = rowIndex;
        break;
      }
    }
    const startLimit = Math.min(sheet.rows.length, tableHeaderRow + 6);
    let startRow = -1;
    let nameColumn = -1;
    for (let rowIndex = tableHeaderRow + 1; rowIndex < startLimit; rowIndex++) {
      const row = sheet.rows[rowIndex];
      const textColumns = row.map((value, column) => ({ text: cellText(value), column }))
        .filter(({ text }) => Boolean(text) && !isUnit(text));
      const numericColumns = row.map((value, column) => isNumeric(value) ? column : -1).filter((column) => column >= 0);
      const labelColumn = textColumns.find(({ column }) => numericColumns.some((numericColumn) => numericColumn > column))?.column
        ?? [...textColumns].reverse().find(({ column }) => numericColumns.some((numericColumn) => numericColumn < column))?.column
        ?? -1;
      if (labelColumn >= 0 && numericColumns.length) {
        startRow = rowIndex;
        nameColumn = labelColumn;
        break;
      }
    }
    if (startRow < 0 || nameColumn < 0) continue;

    const ingredients: OperationalIngredient[] = [];
    let total: OperationalIngredient | undefined;
    let endRow = startRow;
    for (let rowIndex = startRow; rowIndex < Math.min(sheet.rows.length, startRow + 80); rowIndex++) {
      const row = sheet.rows[rowIndex];
      const name = preserveUnquantified ? cellText(row[nameColumn]) : ingredientName(row, nameColumn);
      if (!name) {
        if (rowIndex > startRow && rowStrings(row).length === 0) break;
        continue;
      }
      const amounts = amountCells(sheet, rowIndex, nameColumn, tableHeaderRow, true);
      if (isTotal(name)) {
        total = { name, sourceRow: rowIndex + 1, amounts };
        endRow = rowIndex;
        break;
      }
      if (!amounts.length) {
        if (rowIndex > startRow && /^(?:process|instructions?|directions?)$/i.test(name)) break;
        if (!preserveUnquantified) continue;
      }
      ingredients.push({ name, sourceRow: rowIndex + 1, amounts });
      endRow = rowIndex;
    }
    if (ingredients.length) return { headerRow: tableHeaderRow, startRow, endRow, nameColumn, ingredients, total };
  }
  return null;
}

function parseMappings(sheet: WorkbookSheet, beforeRow: number, dough = false): OperationalProductMapping[] {
  const mappings: OperationalProductMapping[] = [];
  for (let rowIndex = 0; rowIndex < beforeRow; rowIndex++) {
    for (const value of sheet.rows[rowIndex] ?? []) {
      const text = cellText(value);
      const match = text.match(/^([^:]{2,70}):\s*(.{2,160})$/);
      if (!match || (!dough && !/(?:mix|all|pizza|flavor|variet|crb|dough|cheese|pepperoni|chicken|jalapeno|garden)/i.test(match[2]))) continue;
      mappings.push({ sourceRow: rowIndex + 1, product: match[1].trim(), recipe: match[2].trim() });
    }
  }
  return mappings;
}

function parseEquipment(sheet: WorkbookSheet) {
  const equipment: string[] = [];
  const headingIndex = sheet.rows.findIndex((row) => rowStrings(row).some((text) => /^materials$/i.test(text)));
  if (headingIndex < 0) return equipment;
  for (let rowIndex = headingIndex + 1; rowIndex < Math.min(sheet.rows.length, headingIndex + 12); rowIndex++) {
    const row = sheet.rows[rowIndex];
    const strings = rowStrings(row);
    if (!strings.length) {
      if (equipment.length) break;
      continue;
    }
    const value = strings[0];
    if (/\b(?:lbs?|oz|total|ingredients?|step\s*\d)\b/i.test(value) || row.some(isNumeric)) break;
    equipment.push(value);
  }
  return equipment;
}

function parseSteps(sheet: WorkbookSheet, afterRow: number) {
  const steps: OperationalStep[] = [];
  let processMode = false;
  for (let rowIndex = Math.max(0, afterRow); rowIndex < sheet.rows.length; rowIndex++) {
    const text = firstCellText(sheet.rows[rowIndex]);
    if (!text) continue;
    if (/^(?:process|instructions?|directions?)$/i.test(text)) {
      processMode = true;
      continue;
    }
    const numbered = text.match(/^\s*(?:(\d+)[.)]\s*|step\s+(\d+)\s*[:.)-]?\s*)(.*)$/i);
    if (numbered) {
      const order = Number(numbered[1] ?? numbered[2]);
      const body = normalizeText(numbered[3] || text);
      if (body) steps.push({ order: Number.isFinite(order) ? order : steps.length + 1, sourceRow: rowIndex + 1, text: body });
    } else if (processMode) {
      steps.push({ order: steps.length + 1, sourceRow: rowIndex + 1, text });
    }
  }
  return steps;
}

function parseGeneralRecipe(workbook: ParsedWorkbook, sheet: WorkbookSheet, dough = false): OperationalSheet {
  const { title } = titleAndRevision(workbook, sheet);
  const table = findGeneralIngredientTable(sheet, dough);
  const ingredientEndRow = table?.endRow ?? 0;
  const mappings = parseMappings(sheet, table?.headerRow ?? sheet.rows.length, dough);
  const equipment = parseEquipment(sheet);
  const steps = parseSteps(sheet, ingredientEndRow + 1);
  const recipe: OperationalRecipe = {
    name: title,
    source: {
      sheet: sheet.name,
      startRow: (table?.startRow ?? 0) + 1,
      endRow: (table?.endRow ?? sheet.rows.length - 1) + 1,
    },
    ingredients: table?.ingredients ?? [],
    ...(table?.total ? { total: table.total } : {}),
    steps,
    equipment,
    notes: [],
    metrics: [],
  };

  const notes = textRows(sheet)
    .filter(({ index, text }) => {
      if (table && index >= table.startRow && index <= table.endRow) return false;
      if (equipment.includes(text)) return false;
      if (steps.some((step) => step.sourceRow === index + 1)) return false;
      if (/^(?:process|materials|instructions?|directions?)$/i.test(text)) return false;
      return !mappings.some((mapping) => mapping.sourceRow === index + 1);
    })
    .map(({ index, text }) => `Row ${index + 1}: ${text}`);
  recipe.notes = notes;
  if (dough) {
    if (table) {
      for (let rowIndex = table.startRow; rowIndex <= table.endRow; rowIndex++) {
        const rowNotes = sheet.rows[rowIndex].filter((value, column) =>
          column !== table.nameColumn && Boolean(cellText(value)) &&
          !amountCells(sheet, rowIndex, table.nameColumn, table.headerRow, true).some(amount => amount.column === column + 1),
        ).map(cellText);
        if (rowNotes.length) recipe.notes.push(`Row ${rowIndex + 1}: ${rowNotes.join(' · ')}`);
      }
    }
    recipe.dough = extractDoughDetails(sheet, recipe, table?.headerRow ?? 0);
  }

  const recipes = table || steps.length || equipment.length ? [recipe] : [];
  const warning: string[] = [];
  if (!table) warning.push(`No ingredient table was confidently detected in worksheet "${sheet.name}".`);
  if (!steps.length) warning.push(`No numbered process steps were confidently detected in worksheet "${sheet.name}".`);
  if (!recipes.length) warning.push(`No recipe table or process steps were confidently detected in worksheet "${sheet.name}".`);
  return { name: sheet.name, recipes, productMappings: mappings, shippingRecords: [], notes: warning };
}

export function parseOperationalWorkbook(
  workbook: ParsedWorkbook,
  kind: OperationalImportKind,
  selectedSheetNames?: string[],
): OperationalWorkbookData {
  const selected = selectedSheetNames ? new Set(selectedSheetNames) : null;
  const sourceSheets = selected ? workbook.sheets.filter((sheet) => selected.has(sheet.name)) : workbook.sheets;
  const metadataSheet = sourceSheets[0] ?? workbook.sheets[0] ?? { name: workbook.fileName, rows: [] };
  const metadata = titleAndRevision(workbook, metadataSheet, kind === 'cheese' || kind === 'sauce_guide');
  if (kind === 'shipping') {
    const firstText = metadataSheet.rows.flatMap(rowStrings)[0];
    metadata.title = firstText && !/^(?:pizza|product|brand)$/i.test(firstText) ? firstText : workbook.fileName;
  }
  const sheets = sourceSheets.map((sheet) => {
    if (kind === 'shipping') return parseShippingSheet(sheet);
    if (kind === 'premix') return parsePremixSheet(sheet);
    if (kind === 'cheese') return parseCheeseSheet(sheet);
    if (kind === 'sauce_guide') return reviewSauceSheet(sheet, parseGeneralRecipe(workbook, sheet));
    return parseGeneralRecipe(workbook, sheet, kind === 'dough_guide');
  });
  const warnings = sheets.flatMap((sheet) => sheet.notes.filter((note) => /no .*confidently detected|no populated/i.test(note)));
  return {
    format: 'lucia.operational-workbook.v1',
    importKind: kind,
    title: metadata.title,
    revision: metadata.revision,
    availableSheetNames: workbook.sheets.map((sheet) => sheet.name),
    selectedSheetNames: sourceSheets.map((sheet) => sheet.name),
    sheets,
    warnings,
  };
}

export function filterShippingWorkbookByBrand(data: OperationalWorkbookData, brand: string): OperationalWorkbookData {
  const normalize = normalizeShippingBrand;
  const sheets = data.sheets.map((sheet) => ({
    ...sheet,
    shippingRecords: sheet.shippingRecords.filter((record) => normalize(record.brand) === normalize(brand)),
  })).filter((sheet) => sheet.shippingRecords.length > 0);
  if (!sheets.length) {
    throw new Error(`No shipping rows match the selected profile brand “${brand}”. Choose a profile whose brand appears in this workbook.`);
  }
  return { ...data, filteredToBrand: brand, sheets };
}

export function normalizeShippingBrand(value: string) {
  return value.normalize('NFKC').replace(/[‘’]/g, "'").trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function shippingRowCountForBrand(data: OperationalWorkbookData, brand: string) {
  const normalizedBrand = normalizeShippingBrand(brand);
  return data.sheets.reduce((count, sheet) =>
    count + sheet.shippingRecords.filter((record) => normalizeShippingBrand(record.brand) === normalizedBrand).length,
  0);
}
