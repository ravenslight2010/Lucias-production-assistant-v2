export const WORKBOOK_LIMITS = {
  maxBytes: 25 * 1024 * 1024,
  maxSheets: 100,
  maxRowsPerSheet: 20_000,
  maxColumnsPerSheet: 300,
  maxCells: 500_000,
} as const;

export const IMPORT_KINDS = [
  "product_specs",
  "premix",
  "cheese",
  "shipping",
  "sauce_guide",
  "dough_guide",
  "schedule",
] as const;

export type ImportKind = (typeof IMPORT_KINDS)[number];
export type WorkbookCell = string | number | boolean | null;
export type WorkbookSheet = { name: string; rows: WorkbookCell[][] };
export type ParsedWorkbook = {
  fileName: string;
  sizeBytes: number;
  sheetCount: number;
  cellCount: number;
  kind: ImportKind | null;
  kindConfidence: "high" | "review";
  sheets: WorkbookSheet[];
};

export type ParsedScheduleRun = {
  date: string;
  brand: string;
  flavor: string;
  casesPlanned: number;
  notes: string;
  source: { file: string; sheet: string; row: number };
};

export type ScheduleParseResult = {
  runs: ParsedScheduleRun[];
  errors: Array<{ sheet: string; row: number; message: string }>;
  ignoredPastCount: number;
};

export type ProductSpecSection = {
  sheet: string;
  headerRow: number;
  headerColumn: number;
  targetWeightRow: number;
  endRow: number;
  endColumn: number;
};

export type ProductSpecProfileCandidate = {
  id: string;
  brand: string;
  sourceBrand?: string;
  flavor: string;
  sections: ProductSpecSection[];
};

const scheduleUnitHeaders = new Set(["units", "cases", "qty", "quantity", "cases planned"]);
const productSpecHeaderExclusions = new Set([
  "oz",
  "lb",
  "lbs",
  "pound",
  "pounds",
  "brand",
  "flavor",
  "target weight",
  "weight spec range",
  "repack",
  "repacks",
  "product description",
]);

const componentHeaderPattern = /^(?:applicator\b|parbake crust\b|pepperoni stick\b|pizza sauce\b|sauce barrel\b|target weight\b|weight spec range\b)/i;
const quantityExpressionPattern = /^\s*\d+(?:\.\d+)?\s*=\s*\d+(?:\.\d+)?\s*$/;
const instructionHeaderPattern = /^(?:on|use|note|make sure|always|do not|don't|place|when)\b/i;
const revisionHeaderPattern = /\b(?:revision|rev\.?)\b/i;
const dateHeaderPattern = /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/;

function normalizedProductName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function profileKey(brand: string, flavor: string) {
  return JSON.stringify([normalizedProductName(brand).toLocaleLowerCase(), normalizedProductName(flavor).toLocaleLowerCase()]);
}

function productSpecBrand(fileName: string, sourceBrand: string) {
  // This customer workbook reuses Corner Booth headings, but its products
  // belong to separate Kroger profiles. Keep the source cells unchanged.
  const krogerSpecWorkbook = /^kroger[ _-]+pizza[ _-]+recipe[ _-]+specs(?:[ _.-]|$)/i.test(fileName);
  return krogerSpecWorkbook && /^corner booth pizzas?$/i.test(sourceBrand)
    ? "Kroger"
    : sourceBrand;
}

function isProductHeaderName(value: string) {
  const normalized = normalizedProductName(value);
  if (
    !normalized ||
    normalized.length > 80 ||
    productSpecHeaderExclusions.has(normalized.toLocaleLowerCase()) ||
    /\ballergen\b/i.test(normalized) ||
    instructionHeaderPattern.test(normalized) ||
    revisionHeaderPattern.test(normalized) ||
    dateHeaderPattern.test(normalized) ||
    /[,;.!?]/.test(normalized)
  ) return false;
  if (componentHeaderPattern.test(normalized) || quantityExpressionPattern.test(normalized)) return false;
  return !/^\d+(?:\.\d+)?$/.test(normalized);
}

function labelColumnAt(row: WorkbookCell[], column: number) {
  if (typeof row[column + 1] === "string" && cellText(row[column + 1])) return column + 1;
  if (
    row[column + 1] == null &&
    typeof row[column + 2] === "string" &&
    cellText(row[column + 2])
  ) return column + 2;
  return -1;
}

function findTargetWeightRow(
  sheet: WorkbookSheet,
  startRow: number,
  startColumn: number,
  stopBeforeRow: number,
) {
  const limit = Math.min(sheet.rows.length, startRow + 51, stopBeforeRow);
  for (let rowIndex = startRow + 1; rowIndex < limit; rowIndex++) {
    for (const column of [startColumn, startColumn + 1]) {
      if (/^target\s+weight$/i.test(cellText(sheet.rows[rowIndex]?.[column]))) {
        return { row: rowIndex, column };
      }
    }
  }
  return null;
}

function findProductSpecEndRow(
  sheet: WorkbookSheet,
  targetRow: number,
  targetColumn: number,
  stopBeforeRow: number,
) {
  const limit = Math.min(sheet.rows.length, targetRow + 5, stopBeforeRow);
  for (let rowIndex = targetRow + 1; rowIndex < limit; rowIndex++) {
    if (/^weight\s+spec\s+range$/i.test(cellText(sheet.rows[rowIndex]?.[targetColumn]))) {
      return rowIndex;
    }
  }
  return targetRow;
}

/**
 * Split common customer product-spec sheets into reviewable brand/flavor
 * profiles. This only accepts a heading pair followed by a nearby TARGET
 * WEIGHT row; ingredient rows and product codes that resemble quantities are
 * not treated as profile names. Unrecognized layouts remain available through
 * the ordinary single-profile source import.
 */
export function parseProductSpecProfiles(workbook: ParsedWorkbook): ProductSpecProfileCandidate[] {
  const groups = new Map<string, ProductSpecProfileCandidate>();

  for (const sheet of workbook.sheets) {
    const headers: Array<{ row: number; column: number; brand: string; flavor: string }> = [];
    for (let rowIndex = 0; rowIndex < sheet.rows.length; rowIndex++) {
      const row = sheet.rows[rowIndex];
      for (let column = 0; column < row.length - 1; column++) {
        const labelColumn = labelColumnAt(row, column);
        if (labelColumn < 0) continue;
        const brand = normalizedProductName(cellText(row[column]));
        const flavor = normalizedProductName(cellText(row[labelColumn]));
        if (!isProductHeaderName(brand) || !isProductHeaderName(flavor)) continue;
        headers.push({ row: rowIndex, column, brand, flavor });
      }
    }

    const nextRows = new Map<(typeof headers)[number], number>();
    const nextRowByColumn = new Map<number, number>();
    for (let index = headers.length - 1; index >= 0; index--) {
      const header = headers[index];
      nextRows.set(header, nextRowByColumn.get(header.column) ?? sheet.rows.length);
      nextRowByColumn.set(header.column, header.row);
    }
    const nextHeaderRowFor = (header: (typeof headers)[number]) =>
      nextRows.get(header) ?? sheet.rows.length;
    const validHeaders = headers.filter((header) =>
      findTargetWeightRow(sheet, header.row, header.column, nextHeaderRowFor(header)) !== null,
    );
    const columnStarts = [...new Set(validHeaders.map((header) => header.column))]
      .sort((a, b) => a - b);
    const maxColumns = sheet.rows.reduce((max, row) => Math.max(max, row.length), 0);
    for (const header of validHeaders) {
      const nextHeaderRow = nextHeaderRowFor(header);
      const nextColumnStart = columnStarts.find((column) => column > header.column);
      const endColumn = nextColumnStart ?? maxColumns;
      const target = findTargetWeightRow(sheet, header.row, header.column, nextHeaderRow);
      if (!target) continue;
      const section: ProductSpecSection = {
        sheet: sheet.name,
        headerRow: header.row + 1,
        headerColumn: header.column + 1,
        targetWeightRow: target.row + 1,
        endRow: findProductSpecEndRow(sheet, target.row, target.column, nextHeaderRow) + 1,
        endColumn,
      };
      const brand = productSpecBrand(workbook.fileName, header.brand);
      const key = profileKey(brand, header.flavor);
      const candidate = groups.get(key);
      if (candidate) {
        candidate.sections.push(section);
      } else {
        groups.set(key, {
          id: `${key}:${sheet.name}:${section.headerRow}:${section.headerColumn}`,
          brand,
          ...(brand !== header.brand ? { sourceBrand: header.brand } : {}),
          flavor: header.flavor,
          sections: [section],
        });
      }
    }
  }

  return [...groups.values()];
}

function cellText(value: WorkbookCell | undefined) {
  return value == null ? "" : String(value).trim();
}

function cellDate(value: WorkbookCell | undefined): string | null {
  if (typeof value === "number" && value >= 20_000 && value <= 90_000) {
    return new Date(Math.round((value - 25_569) * 86_400_000)).toISOString().slice(0, 10);
  }
  const text = cellText(value);
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (iso) return `${iso[1]}-${String(Number(iso[2])).padStart(2, "0")}-${String(Number(iso[3])).padStart(2, "0")}`;
  const us = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(text);
  if (!us) return null;
  const year = us[3].length === 2 ? 2000 + Number(us[3]) : Number(us[3]);
  return `${year}-${String(Number(us[1])).padStart(2, "0")}-${String(Number(us[2])).padStart(2, "0")}`;
}

export function parseScheduleWorkbook(workbook: ParsedWorkbook, importDate?: string): ScheduleParseResult {
  const runs: ParsedScheduleRun[] = [];
  const errors: ScheduleParseResult["errors"] = [];
  let ignoredPastCount = 0;
  for (const sheet of workbook.sheets) {
    let row = 0;
    while (row < sheet.rows.length) {
      const header = sheet.rows[row];
      const findCol = (wanted: string[]) => header.findIndex((cell) => typeof cell === "string" && wanted.includes(cell.trim().toLowerCase()));
      const brandCol = findCol(["brand"]);
      const flavorCol = findCol(["flavor"]);
      const unitsCol = findCol([...scheduleUnitHeaders]);
      if (brandCol < 0 || flavorCol < 0 || unitsCol < 0) { row++; continue; }
      const date = header.map(cellDate).find((value) => value !== null) ?? null;
      const customerCol = findCol(["customer"]);
      const shipCol = findCol(["ship", "ship date", "shipdate"]);
      const poCol = findCol(["po", "po #", "po#", "po number"]);
      let next = row + 1;
      for (; next < sheet.rows.length; next++) {
        const cells = sheet.rows[next];
        const isHeader = cells.some((cell, index) =>
          typeof cell === "string" && cell.trim().toLowerCase() === "brand",
        ) && cells.some((cell) => typeof cell === "string" && cell.trim().toLowerCase() === "flavor")
          && cells.some((cell) => typeof cell === "string" && scheduleUnitHeaders.has(cell.trim().toLowerCase()));
        if (isHeader) break;
        const brand = cellText(cells[brandCol]);
        const flavor = cellText(cells[flavorCol]);
        const units = cellText(cells[unitsCol]);
        if (!brand && !flavor) continue;
        if (/^-?\d+(\.\d+)?$/.test(brand) || (!brand && /^-?\d+(\.\d+)?$/.test(flavor))) continue;
        const normalizedFlavor = flavor.toLowerCase().replace(/\s+/g, " ");
        if (!brand && (/^(carton |closed -|inventory|qc school)/.test(normalizedFlavor) || normalizedFlavor === "breakfast is old shells and old labels")) continue;
        if (date && importDate && date < importDate) { ignoredPastCount++; continue; }
        if (!date) { errors.push({ sheet: sheet.name, row: next + 1, message: `${brand || flavor} has no valid day date` }); continue; }
        if (!brand) { errors.push({ sheet: sheet.name, row: next + 1, message: "Missing brand" }); continue; }
        const quantity = units === "" ? 0 : Number(units.replace(/[, ]/g, ""));
        if (!Number.isFinite(quantity) || quantity < 0) { errors.push({ sheet: sheet.name, row: next + 1, message: `Invalid units: ${units}` }); continue; }
        const casesPlanned = Math.round(quantity);
        if (casesPlanned < 1 || casesPlanned > 2_147_483_647) { errors.push({ sheet: sheet.name, row: next + 1, message: "Cases must be between 1 and 2,147,483,647 to create a planned run" }); continue; }
        const noteParts = [
          customerCol >= 0 ? cellText(cells[customerCol]) : "",
          poCol >= 0 && cellText(cells[poCol]) ? `PO ${cellText(cells[poCol])}` : "",
          shipCol >= 0 && cellText(cells[shipCol]) ? `Ship ${cellDate(cells[shipCol]) ?? cellText(cells[shipCol])}` : "",
        ].filter(Boolean);
        const notes = noteParts.join(" · ");
        if (notes.length > 500) { errors.push({ sheet: sheet.name, row: next + 1, message: "Customer, PO, and shipping notes exceed the 500-character limit" }); continue; }
        runs.push({
          date,
          brand,
          flavor,
          casesPlanned,
          notes,
          source: { file: workbook.fileName, sheet: sheet.name, row: next + 1 },
        });
      }
      row = next;
    }
  }
  return { runs, errors, ignoredPastCount };
}

function cellValue(value: unknown): WorkbookCell {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return null;
}

export function detectImportKind(sheets: WorkbookSheet[], sourceFileName = ""): {
  kind: ImportKind | null;
  confidence: "high" | "review";
} {
  const text = sheets
    .flatMap((sheet) => sheet.rows.slice(0, 40).flat())
    .filter((cell): cell is string => typeof cell === "string")
    .join(" ")
    .toLowerCase();
  const fileName = sourceFileName.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const candidates: Array<[ImportKind, number]> = [
    ["shipping", Number(/shipping boxes|palletiz/.test(text)) * 5],
    ["schedule", Number(/week of|production schedule/.test(text)) * 4 + Number(/\bday\b/.test(text))],
    ["cheese", Number(sheets.length >= 10 && /cheese shredder|cheese mix/.test(text)) * 5],
    ["premix",
      Number(/per batch\s*\(lbs\)|#\s*of mixes|total needed/.test(text)) * 4 +
      Number(/\bpre\s*mix\b/.test(fileName)) * 4],
    ["dough_guide",
      Number(/dough mixing procedure|doughball|dough balls/.test(text)) * 5 +
      Number(/\bdough\b.*\b(?:mixing|procedure|process)\b/.test(fileName)) * 5],
    ["sauce_guide", Number(/sauce procedure|sauce mix|sauce barrel|masala sauce/.test(text)) * 4],
    ["product_specs",
      Number(/\b(?:pizza|pizzas)\b/.test(fileName) && /\b(?:recipe|specs?)\b/.test(fileName)) * 4 +
      Number(/applicator|die type|oz\s*\/?\s*pizza/.test(text)) * 2 +
      Number(/target weight/.test(text)) * 2 +
      Number(/weight spec range/.test(text)) * 2],
  ];
  candidates.sort((a, b) => b[1] - a[1]);
  const [kind, score] = candidates[0];
  const second = candidates[1]?.[1] ?? 0;
  return score >= 4 && score > second
    ? { kind, confidence: "high" }
    : { kind: null, confidence: "review" };
}

export async function parseWorkbookFile(file: File): Promise<ParsedWorkbook> {
  if (!/\.(xlsx|xlsm)$/i.test(file.name)) {
    throw new Error("Choose an .xlsx or .xlsm workbook.");
  }
  if (file.size <= 0 || file.size > WORKBOOK_LIMITS.maxBytes) {
    throw new Error("Workbook must be between 1 byte and 25 MB.");
  }
  const XLSX = await import("xlsx");
  const bytes = await file.arrayBuffer();
  const workbook = XLSX.read(bytes, {
    type: "array",
    cellFormula: false,
    cellHTML: false,
    cellText: false,
  });
  if (workbook.SheetNames.length === 0 || workbook.SheetNames.length > WORKBOOK_LIMITS.maxSheets) {
    throw new Error("Workbook must contain between 1 and 100 worksheets.");
  }

  let cellCount = 0;
  const sheets: WorkbookSheet[] = workbook.SheetNames.map((name) => {
    const worksheet = workbook.Sheets[name];
    if (!worksheet) return { name, rows: [] };
    const populatedCells = Object.keys(worksheet)
      .filter((address) => /^[A-Z]+[1-9]\d*$/.test(address))
      .filter((address) => worksheet[address]?.v !== undefined)
      .map((address) => XLSX.utils.decode_cell(address));
    if (!populatedCells.length) return { name, rows: [] };
    const endRow = Math.max(...populatedCells.map(({ r }) => r));
    const endColumn = Math.max(...populatedCells.map(({ c }) => c));
    const rowCount = endRow + 1;
    const columnCount = endColumn + 1;
    if (rowCount > WORKBOOK_LIMITS.maxRowsPerSheet || columnCount > WORKBOOK_LIMITS.maxColumnsPerSheet) {
      throw new Error(`Worksheet "${name}" exceeds the row or column limit.`);
    }
    cellCount += rowCount * columnCount;
    if (cellCount > WORKBOOK_LIMITS.maxCells) {
      throw new Error("Workbook exceeds the 500,000-cell limit.");
    }
    const rows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
      range: XLSX.utils.encode_range({
        s: { r: 0, c: 0 },
        e: { r: endRow, c: endColumn },
      }),
    }).map((row) => row.map(cellValue));
    return { name: name.slice(0, 80), rows };
  });
  const detected = detectImportKind(sheets, file.name);
  return {
    fileName: file.name.slice(0, 255),
    sizeBytes: file.size,
    sheetCount: sheets.length,
    cellCount,
    kind: detected.kind,
    kindConfidence: detected.confidence,
    sheets,
  };
}
