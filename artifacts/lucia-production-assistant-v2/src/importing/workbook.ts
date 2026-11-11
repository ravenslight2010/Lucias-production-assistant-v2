import * as XLSX from "xlsx";

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

function cellValue(value: unknown): WorkbookCell {
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  return null;
}

export function detectImportKind(sheets: WorkbookSheet[]): {
  kind: ImportKind | null;
  confidence: "high" | "review";
} {
  const text = sheets
    .flatMap((sheet) => sheet.rows.slice(0, 40).flat())
    .filter((cell): cell is string => typeof cell === "string")
    .join(" ")
    .toLowerCase();
  const candidates: Array<[ImportKind, number]> = [
    ["shipping", Number(/shipping boxes|palletiz/.test(text)) * 5],
    ["schedule", Number(/week of|production schedule/.test(text)) * 4 + Number(/\bday\b/.test(text))],
    ["cheese", Number(sheets.length >= 10 && /cheese shredder|cheese mix/.test(text)) * 5],
    ["premix", Number(/per batch\s*\(lbs\)|#\s*of mixes|total needed/.test(text)) * 4],
    ["dough_guide", Number(/dough mixing procedure|doughball|dough balls/.test(text)) * 5],
    ["sauce_guide", Number(/sauce procedure|sauce mix|sauce barrel/.test(text)) * 4],
    ["product_specs", Number(/pizza recipe specs|pizza specs|applicator|die type|oz\s*\/?\s*pizza/.test(text)) * 3],
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
  const detected = detectImportKind(sheets);
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
