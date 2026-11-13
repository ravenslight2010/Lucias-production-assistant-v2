import { parseProductSpecProfiles, WORKBOOK_LIMITS } from "./workbook.ts";
import type {
  ParsedWorkbook,
  ProductSpecProfileCandidate,
  ProductSpecSection,
  WorkbookCell,
} from "./workbook";

export type ProductSpecAmount = {
  column: string;
  value: string;
};

export type ProductSpecIngredient = {
  sourceRow: number;
  sourceCoordinates: {
    sheet: string;
    row: number;
    nameColumn: string;
  };
  ingredientRole: "sauce" | "pep_applicator" | "cheese_applicator" | "ingredient";
  name: string;
  amounts: ProductSpecAmount[];
};

export type ProductSpecSectionData = {
  sheet: string;
  headerRow: number;
  endRow: number;
  unit: string | null;
  ingredients: ProductSpecIngredient[];
  targetWeight: string | null;
  weightSpecRange: string | null;
  notes: string[];
  warnings: string[];
};

export type ProductSpecData = {
  format: "lucia.product-spec.v1";
  brand: string;
  flavor: string;
  sections: ProductSpecSectionData[];
  warnings: string[];
};

function cellText(value: WorkbookCell | undefined) {
  if (value == null) return "";
  return String(value).normalize("NFKC").trim().replace(/\s+/g, " ");
}

function excelColumnLabel(index: number) {
  let column = index + 1;
  let label = "";
  while (column > 0) {
    const remainder = (column - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    column = Math.floor((column - 1) / 26);
  }
  return label;
}

function ingredientRole(name: string): ProductSpecIngredient["ingredientRole"] {
  const label = name.normalize("NFKC").trim().toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (/\bsauce\b/.test(label) && !/^applicator\b/.test(label)) return "sauce";
  if (
    /^(?:pep|pepperoni) applicator$/.test(label) ||
    /^applicator\b.*\b(?:pep|pepperoni)\b.*\bcheese (?:mix|blend)\b/.test(label)
  ) return "pep_applicator";
  if (
    /^cheese applicator$/.test(label) ||
    /^applicator\b.*\b(?:cheese|mozzarella)\b/.test(label)
  ) return "cheese_applicator";
  return "ingredient";
}

function sectionColumns(section: ProductSpecSection, sheetColumnCount: number) {
  const first = Math.max(0, section.headerColumn - 1);
  const lastExclusive = Math.max(first + 1, Math.min(sheetColumnCount, section.endColumn ?? sheetColumnCount));
  return { labelColumn: first, lastExclusive };
}

function parseSection(
  workbook: ParsedWorkbook,
  section: ProductSpecSection,
): ProductSpecSectionData | null {
  const sheet = workbook.sheets.find((item) => item.name === section.sheet);
  if (!sheet) return null;

  const sheetColumnCount = sheet.rows.reduce((max, row) => Math.max(max, row.length), 0);
  const { labelColumn, lastExclusive } = sectionColumns(section, sheetColumnCount);
  const ingredients: ProductSpecIngredient[] = [];
  const notes = new Set<string>();
  const warnings: string[] = [];
  let targetWeight: string | null = null;
  let weightSpecRange: string | null = null;
  // The provided pizza specification workbooks label their weight unit in the
  // worksheet tab (for example, "OZ"), rather than repeating it in every row.
  let unit: string | null = /^oz$/i.test(section.sheet.trim()) ? "oz" : null;
  const contextStart = Math.max(0, section.headerRow - 3);
  const contextEnd = Math.max(contextStart, section.headerRow - 1);
  for (let rowIndex = contextStart; rowIndex < contextEnd; rowIndex++) {
    const row = sheet.rows[rowIndex] ?? [];
    const context = row.slice(labelColumn, lastExclusive).map(cellText).filter(Boolean).join(" · ");
    if (context && /(?:\ballergen\b|^note\b|^on\s+\d|^use\b|^do not\b|^don't\b|^always\b|^when\b|^place\b)/i.test(context)) {
      notes.add(context);
    }
  }
  const startIndex = Math.max(0, section.headerRow);
  const endIndex = Math.min(sheet.rows.length, section.endRow);

  for (let rowIndex = startIndex; rowIndex < endIndex; rowIndex++) {
    const row = sheet.rows[rowIndex] ?? [];
    const localValues = row.slice(labelColumn, lastExclusive);
    const normalizedValues = localValues.map(cellText);
    const unitIndex = normalizedValues.findIndex((value) => /^oz$/i.test(value));
    if (unitIndex >= 0) unit = normalizedValues[unitIndex].toLocaleLowerCase();

    const targetIndex = normalizedValues.findIndex((value) => /^target\s+weight$/i.test(value));
    if (targetIndex >= 0) {
      targetWeight = normalizedValues[targetIndex + 1] || targetWeight;
      continue;
    }

    const rangeIndex = normalizedValues.findIndex((value) => /^weight\s+spec\s+range$/i.test(value));
    if (rangeIndex >= 0) {
      weightSpecRange = normalizedValues[rangeIndex + 1] || weightSpecRange;
      continue;
    }

    const rowText = normalizedValues.filter(Boolean).join(" · ");
    if (/\ballergen\b/i.test(rowText)) {
      notes.add(rowText);
      continue;
    }

    const name = cellText(row[labelColumn]);
    if (!name || /^oz$/i.test(name)) continue;
    if (/^(?:note\b|on\s+\d|use\b|do not\b|don't\b|always\b|when\b|place\b)/i.test(name)) {
      notes.add(name);
      continue;
    }

    const amounts: ProductSpecAmount[] = [];
    for (let column = labelColumn + 1; column < lastExclusive; column++) {
      const text = cellText(row[column]);
      // A blank separator ends the formula columns. Do not pull a neighboring
      // repack, shipping, or instruction table into the ingredient amounts.
      if (!text) break;
      amounts.push({ column: excelColumnLabel(column), value: text });
    }
    ingredients.push({
      sourceRow: rowIndex + 1,
      sourceCoordinates: {
        sheet: section.sheet,
        row: rowIndex + 1,
        nameColumn: excelColumnLabel(labelColumn),
      },
      ingredientRole: ingredientRole(name),
      name,
      amounts,
    });
  }

  if (!targetWeight) warnings.push("Target weight was not detected in this section.");
  if (!weightSpecRange) warnings.push("Weight spec range was not detected in this section.");
  if (!ingredients.length) warnings.push("No ingredient rows were detected in this section.");

  return {
    sheet: section.sheet,
    headerRow: section.headerRow,
    endRow: section.endRow,
    unit,
    ingredients,
    targetWeight,
    weightSpecRange,
    notes: [...notes],
    warnings,
  };
}

export function parseProductSpecData(
  workbook: ParsedWorkbook,
  candidate: ProductSpecProfileCandidate,
): ProductSpecData {
  const sections = candidate.sections
    .map((section) => parseSection(workbook, section))
    .filter((section): section is ProductSpecSectionData => section !== null);
  const warnings: string[] = [];
  if (!sections.length) warnings.push("No complete product-spec sections were available to extract.");
  if (sections.length !== candidate.sections.length) {
    warnings.push("One or more source worksheets were not available for this profile.");
  }

  return {
    format: "lucia.product-spec.v1",
    brand: candidate.brand,
    flavor: candidate.flavor,
    sections,
    warnings,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * Older imports already retain the selected section and sparse source cells.
 * Derive their readable view without mutating the saved profile/run snapshot or
 * requiring a reimport that would otherwise be treated as an identical retry.
 */
export function parsePreservedProductSpec(value: unknown): ProductSpecData | null {
  if (!isRecord(value) || value.format !== "lucia.workbook.sparse.v1" ||
      !isRecord(value.selectedProduct) || !Array.isArray(value.sheets) ||
      value.sheets.length > WORKBOOK_LIMITS.maxSheets) return null;
  const selected = value.selectedProduct;
  if (typeof selected.brand !== "string" || typeof selected.flavor !== "string" ||
      !Array.isArray(selected.sections) || !selected.sections.length) return null;

  const sheets: ParsedWorkbook["sheets"] = [];
  let cellCount = 0;
  for (const rawSheet of value.sheets) {
    if (!isRecord(rawSheet) || typeof rawSheet.name !== "string" ||
        !Array.isArray(rawSheet.cells)) return null;
    const rows: WorkbookCell[][] = [];
    for (const rawCell of rawSheet.cells) {
      if (++cellCount > WORKBOOK_LIMITS.maxCells || !isRecord(rawCell)) return null;
      const { r, c, v } = rawCell;
      if (typeof r !== "number" || !Number.isInteger(r) || r < 0 || r >= WORKBOOK_LIMITS.maxRowsPerSheet ||
          typeof c !== "number" || !Number.isInteger(c) || c < 0 || c >= WORKBOOK_LIMITS.maxColumnsPerSheet ||
          !(v === null || typeof v === "string" || typeof v === "boolean" ||
            (typeof v === "number" && Number.isFinite(v)))) return null;
      (rows[r] ??= [])[c] = v;
    }
    sheets.push({
      name: rawSheet.name,
      rows: Array.from({ length: rows.length }, (_, index) => rows[index] ?? []),
    });
  }

  const workbook: ParsedWorkbook = {
    fileName: "Preserved product specifications",
    sizeBytes: 0,
    sheetCount: sheets.length,
    cellCount,
    kind: "product_specs",
    kindConfidence: "review",
    sheets,
  };
  const requestedSections = new Set(selected.sections.flatMap((section) =>
    isRecord(section) && typeof section.sheet === "string" &&
    Number.isInteger(section.headerRow) && Number.isInteger(section.headerColumn)
      ? [JSON.stringify([section.sheet, section.headerRow, section.headerColumn])]
      : [],
  ));
  const sections = parseProductSpecProfiles(workbook)
    .flatMap((candidate) => candidate.sections)
    .filter((section) => requestedSections.has(JSON.stringify([
      section.sheet, section.headerRow, section.headerColumn,
    ])));
  if (!sections.length) return null;

  return parseProductSpecData(workbook, {
    id: "preserved-spec",
    brand: selected.brand,
    flavor: selected.flavor,
    sections,
  });
}
