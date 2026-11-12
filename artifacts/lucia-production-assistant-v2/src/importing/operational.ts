import type { ImportKind, ParsedWorkbook, WorkbookCell, WorkbookSheet } from './workbook';

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

function titleAndRevision(workbook: ParsedWorkbook, sheet: WorkbookSheet) {
  const rows = sheet.rows.slice(0, 8);
  const allText = rows.flatMap(rowStrings);
  const title = allText.find((text) =>
    !/^(?:per\s+pizza|per\s+batch|ingredients?|lbs?|oz\.?)\b/i.test(text) &&
    /(?:\bpremix\b|\b(?:dough|sauce|cheese|mix|recipe|pizza)\b)/i.test(text),
  )
    ?? allText[0]
    ?? sheet.name
    ?? workbook.fileName;
  const revisionText = allText.find((text) => /\brev(?:ision)?\.?\s*[#:-]?\s*[a-z0-9.]+/i.test(text));
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

function findGeneralIngredientTable(sheet: WorkbookSheet) {
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
      const name = ingredientName(row, nameColumn);
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
        continue;
      }
      ingredients.push({ name, sourceRow: rowIndex + 1, amounts });
      endRow = rowIndex;
    }
    if (ingredients.length) return { headerRow: tableHeaderRow, startRow, endRow, nameColumn, ingredients, total };
  }
  return null;
}

function parseMappings(sheet: WorkbookSheet, beforeRow: number): OperationalProductMapping[] {
  const mappings: OperationalProductMapping[] = [];
  for (let rowIndex = 0; rowIndex < Math.min(beforeRow, 24); rowIndex++) {
    for (const value of sheet.rows[rowIndex] ?? []) {
      const text = cellText(value);
      const match = text.match(/^([^:]{2,70}):\s*(.{2,160})$/);
      if (!match || !/(?:mix|all|pizza|flavor|variet|crb|dough|cheese|pepperoni|chicken|jalapeno|garden)/i.test(match[2])) continue;
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

function parseGeneralRecipe(workbook: ParsedWorkbook, sheet: WorkbookSheet): OperationalSheet {
  const { title } = titleAndRevision(workbook, sheet);
  const table = findGeneralIngredientTable(sheet);
  const ingredientEndRow = table?.endRow ?? 0;
  const mappings = parseMappings(sheet, table?.headerRow ?? sheet.rows.length);
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

  const recipes = table || steps.length || equipment.length ? [recipe] : [];
  const warning: string[] = [];
  if (!table) warning.push(`No ingredient table was confidently detected in worksheet "${sheet.name}".`);
  if (!steps.length) warning.push(`No numbered process steps were confidently detected in worksheet "${sheet.name}".`);
  if (!recipes.length) warning.push(`No recipe table or process steps were confidently detected in worksheet "${sheet.name}".`);
  return { name: sheet.name, recipes, productMappings: mappings, shippingRecords: [], notes: warning };
}

function nearestHeading(sheet: WorkbookSheet, labelColumn: number, headerRow: number) {
  let fallback = '';
  for (let rowIndex = headerRow - 1; rowIndex >= Math.max(0, headerRow - 6); rowIndex--) {
    const text = cellText(sheet.rows[rowIndex]?.[labelColumn]);
    if (!text || isUnit(text) || isTotal(text) || /\b(?:for\s+\d+(?:st|nd|rd|th)\s+cheese applicator|percent|revision|rev\.?)\b/i.test(text)) continue;
    fallback ||= text;
    if (/\b(?:mix|blend|recipe)\b/i.test(text)) return text;
  }
  return fallback;
}

function nearestRecipeHeading(sheet: WorkbookSheet, labelColumn: number, headerRow: number) {
  const preferred = nearestHeading(sheet, labelColumn, headerRow + 1);
  const isGeneric = (value: string) => /^(?:ingredient|ingredients|per pizza|per batch|total|quantity|qty|lbs?|oz\.?)$/i.test(value);
  if (preferred && !isGeneric(preferred)) return preferred;
  for (let rowIndex = headerRow - 1; rowIndex >= Math.max(0, headerRow - 6); rowIndex--) {
    const candidate = rowStrings(sheet.rows[rowIndex]).find((text) =>
      !isGeneric(text) && /\b(?:mix|premix|cheese|recipe|pizza|flavor|sauce)\b/i.test(text),
    );
    if (candidate) return candidate;
  }
  return preferred && !isGeneric(preferred) ? preferred : sheet.name;
}

function parseCheeseRecipes(sheet: WorkbookSheet): OperationalSheet {
  const recipes: OperationalRecipe[] = [];
  const seen = new Set<string>();
  for (let headerRow = 0; headerRow < sheet.rows.length; headerRow++) {
    const unitColumns = sheet.rows[headerRow]
      .map((value, column) => ({ value: cellText(value), column }))
      .filter(({ value }) => /^lbs?\.?$/i.test(value));
    for (const { column: unitColumn } of unitColumns) {
      if (unitColumn === 0) continue;
      const labelColumn = unitColumn - 1;
      const name = nearestHeading(sheet, labelColumn, headerRow);
      if (!name) continue;
      const ingredients: OperationalIngredient[] = [];
      let total: OperationalIngredient | undefined;
      let endRow = headerRow;
      for (let rowIndex = headerRow + 1; rowIndex < Math.min(sheet.rows.length, headerRow + 35); rowIndex++) {
        const row = sheet.rows[rowIndex];
        const label = cellText(row[labelColumn]);
        if (!label) continue;
        const amounts = amountCells(sheet, rowIndex, labelColumn, headerRow);
        const targetAmount = row[unitColumn];
        if (isTotal(label)) {
          total = { name: label, sourceRow: rowIndex + 1, amounts };
          endRow = rowIndex;
          break;
        }
        if (isNumeric(targetAmount)) {
          ingredients.push({ name: label, sourceRow: rowIndex + 1, amounts: [{ column: unitColumn + 1, label: 'LBS', value: targetAmount }] });
          endRow = rowIndex;
        }
      }
      const key = `${sheet.name}:${headerRow}:${labelColumn}:${name}`;
      if (!total || !ingredients.length || seen.has(key)) continue;
      seen.add(key);
      recipes.push({
        name,
        source: { sheet: sheet.name, startRow: headerRow + 2, endRow: endRow + 1 },
        ingredients,
        total,
        steps: [],
        equipment: [],
        notes: [],
        metrics: [],
      });
    }
  }
  const productMappings = parseMappings(sheet, Math.min(sheet.rows.length, 16));
  const notes = recipes.length ? [] : [`No complete cheese-mix tables were confidently detected in worksheet "${sheet.name}".`];
  return { name: sheet.name, recipes, productMappings, shippingRecords: [], notes };
}

function parsePremixRecipes(sheet: WorkbookSheet): OperationalSheet {
  const recipes: OperationalRecipe[] = [];
  for (let headerRow = 0; headerRow < sheet.rows.length; headerRow++) {
    const row = sheet.rows[headerRow];
    const batchColumns = row
      .map((value, column) => ({ label: cellText(value), column }))
      .filter(({ label }) => /per\s+batch/i.test(label));
    for (const { column: batchColumn } of batchColumns) {
      const pizzaColumn = batchColumn - 1;
      const nameColumn = batchColumn - 2;
      if (nameColumn < 0 || !/per\s+pizza/i.test(cellText(row[pizzaColumn]))) continue;
      const name = nearestRecipeHeading(sheet, nameColumn, headerRow);
      const ingredients: OperationalIngredient[] = [];
      let total: OperationalIngredient | undefined;
      let totalRow = headerRow;
      for (let rowIndex = headerRow + 1; rowIndex < Math.min(sheet.rows.length, headerRow + 50); rowIndex++) {
        const label = cellText(sheet.rows[rowIndex]?.[nameColumn]);
        if (!label) continue;
        const amounts = amountCells(sheet, rowIndex, nameColumn, headerRow);
        if (isTotal(label)) {
          total = { name: label, sourceRow: rowIndex + 1, amounts };
          totalRow = rowIndex;
          break;
        }
        if (amounts.length) ingredients.push({ name: label, sourceRow: rowIndex + 1, amounts });
      }
      if (!ingredients.length) continue;

      const metrics: OperationalIngredient[] = [];
      let pullStart = -1;
      for (let rowIndex = totalRow + 1; rowIndex < sheet.rows.length; rowIndex++) {
        const rowTextValue = rowStrings(sheet.rows[rowIndex]).join(' ');
        if (/\bpull\s+for\s+mix\b/i.test(rowTextValue)) {
          pullStart = rowIndex;
          break;
        }
        const label = cellText(sheet.rows[rowIndex]?.[nameColumn]);
        if (label && rowIndex > totalRow) {
          const amounts = amountCells(sheet, rowIndex, nameColumn, headerRow);
          if (amounts.length) metrics.push({ name: label, sourceRow: rowIndex + 1, amounts });
        }
      }

      if (pullStart >= 0) {
        let blankRows = 0;
        for (let rowIndex = pullStart + 1; rowIndex < sheet.rows.length && blankRows < 2; rowIndex++) {
          const row = sheet.rows[rowIndex];
          const label = cellText(row[nameColumn]);
          if (!label) {
            blankRows++;
            continue;
          }
          blankRows = 0;
          const amounts = amountCells(sheet, rowIndex, nameColumn, headerRow);
          if (amounts.length) metrics.push({ name: `Pull: ${label}`, sourceRow: rowIndex + 1, amounts });
        }
      }

      recipes.push({
        name,
        source: { sheet: sheet.name, startRow: headerRow + 2, endRow: Math.max(totalRow, pullStart) + 1 },
        ingredients,
        ...(total ? { total } : {}),
        steps: [],
        equipment: [],
        notes: [],
        metrics,
      });
    }
  }
  const notes: string[] = [];
  if (!recipes.length) notes.push(`No per-pizza/per-batch mix tables were confidently detected in worksheet "${sheet.name}".`);
  return { name: sheet.name, recipes, productMappings: [], shippingRecords: [], notes };
}

function parseShippingRecords(sheet: WorkbookSheet): OperationalSheet {
  const headerRow = sheet.rows.findIndex((row) => {
    const text = rowStrings(row).join(' ').toLowerCase();
    return /\bpizza\b/.test(text) && /\bbox\b/.test(text) && /pallet/.test(text);
  });
  if (headerRow < 0) {
    return { name: sheet.name, recipes: [], productMappings: [], shippingRecords: [], notes: ['No shipping table header was confidently detected.'] };
  }
  const headers = sheet.rows[headerRow].map((value) => cellText(value));
  const shippingRecords: OperationalShippingRecord[] = [];
  for (let rowIndex = headerRow + 1; rowIndex < sheet.rows.length; rowIndex++) {
    const row = sheet.rows[rowIndex];
    const brand = cellText(row[0]);
    if (!brand) continue;
    const values: Record<string, OperationalValue> = {};
    for (let column = 0; column < headers.length; column++) {
      const value = row[column];
      const header = headers[column];
      if (header && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')) {
        values[header] = value;
      }
    }
    shippingRecords.push({ sourceRow: rowIndex + 1, brand, values });
  }
  return {
    name: sheet.name,
    recipes: [],
    productMappings: [],
    shippingRecords,
    notes: shippingRecords.length ? [] : ['The shipping table had no populated product rows.'],
  };
}

export function parseOperationalWorkbook(
  workbook: ParsedWorkbook,
  kind: OperationalImportKind,
  selectedSheetNames?: string[],
): OperationalWorkbookData {
  const selected = selectedSheetNames ? new Set(selectedSheetNames) : null;
  const sourceSheets = selected ? workbook.sheets.filter((sheet) => selected.has(sheet.name)) : workbook.sheets;
  const metadataSheet = sourceSheets[0] ?? workbook.sheets[0] ?? { name: workbook.fileName, rows: [] };
  const metadata = titleAndRevision(workbook, metadataSheet);
  const sheets = sourceSheets.map((sheet) => {
    if (kind === 'shipping') return parseShippingRecords(sheet);
    if (kind === 'premix') return parsePremixRecipes(sheet);
    if (kind === 'cheese') return parseCheeseRecipes(sheet);
    return parseGeneralRecipe(workbook, sheet);
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
  const normalize = (value: string) => value.normalize('NFKC').replace(/[‘’]/g, "'").trim().replace(/\s+/g, ' ').toLocaleLowerCase();
  const sheets = data.sheets.map((sheet) => ({
    ...sheet,
    shippingRecords: sheet.shippingRecords.filter((record) => normalize(record.brand) === normalize(brand)),
  })).filter((sheet) => sheet.shippingRecords.length > 0);
  if (!sheets.length) {
    throw new Error(`No shipping rows match the selected profile brand “${brand}”. Choose a profile whose brand appears in this workbook.`);
  }
  return { ...data, filteredToBrand: brand, sheets };
}
