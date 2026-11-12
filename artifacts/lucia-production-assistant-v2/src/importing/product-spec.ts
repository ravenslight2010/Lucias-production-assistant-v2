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
  let unit: string | null = null;
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
      targetWeight = normalizedValues.slice(targetIndex + 1).find(Boolean) ?? targetWeight;
      continue;
    }

    const rangeIndex = normalizedValues.findIndex((value) => /^weight\s+spec\s+range$/i.test(value));
    if (rangeIndex >= 0) {
      weightSpecRange = normalizedValues.slice(rangeIndex + 1).find(Boolean) ?? weightSpecRange;
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

    const amounts = row
      .slice(labelColumn + 1, lastExclusive)
      .flatMap((value, offset) => {
        const text = cellText(value);
        if (!text) return [];
        return [{
          column: excelColumnLabel(labelColumn + 1 + offset),
          value: text,
        }];
      });
    ingredients.push({ sourceRow: rowIndex + 1, name, amounts });
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
