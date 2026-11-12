type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const positiveInteger = (value: unknown, limit: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= limit;

/**
 * File bytes alone do not identify a reviewed dough import: one workbook can
 * contain several portion/batch choices for the same product. Include that
 * explicit choice in retry identity without changing the original file hash.
 * Legacy imports without selection metadata retain their existing identity.
 */
export function doughImportSelectionIdentity(value: unknown): string | null {
  if (!record(value) || !record(value.structured) || value.structured.importKind !== "dough_guide") return null;
  const structured = value.structured;
  if (!Array.isArray(structured.sheets) || structured.sheets.length > 100) throw new Error("Invalid dough selection.");
  const selections: Array<[string, number, number]> = [];
  for (const sheet of structured.sheets) {
    if (!record(sheet) || typeof sheet.name !== "string" || sheet.name.length > 80 ||
        !Array.isArray(sheet.recipes) || sheet.recipes.length > 100) throw new Error("Invalid dough selection.");
    for (const recipe of sheet.recipes) {
      if (!record(recipe) || !record(recipe.dough) || recipe.dough.selection === undefined) continue;
      const { selection, portions, batches, issues } = recipe.dough;
      if (!record(selection) || !positiveInteger(selection.batchColumn, 300) ||
          !positiveInteger(selection.portionSourceRow, 20_000) ||
          typeof selection.reviewedAsReference !== "boolean" ||
          !Array.isArray(portions) || portions.length !== 1 ||
          !record(portions[0]) || portions[0].sourceRow !== selection.portionSourceRow ||
          !Array.isArray(batches) || batches.length !== 1 ||
          !record(batches[0]) || batches[0].column !== selection.batchColumn ||
          !Array.isArray(issues) || (issues.length > 0 && !selection.reviewedAsReference)) {
        throw new Error("Invalid or unreviewed dough selection.");
      }
      if (!Array.isArray(recipe.ingredients) || !recipe.ingredients.every(ingredient =>
        record(ingredient) && Array.isArray(ingredient.amounts) && ingredient.amounts.every(amount =>
          record(amount) && amount.column === selection.batchColumn,
        ),
      )) throw new Error("Dough ingredients do not match the selected batch.");
      if (recipe.total !== undefined && (!record(recipe.total) ||
          !Array.isArray(recipe.total.amounts) || !recipe.total.amounts.every(amount =>
            record(amount) && amount.column === selection.batchColumn,
          ))) throw new Error("Dough total does not match the selected batch.");
      selections.push([sheet.name, selection.portionSourceRow, selection.batchColumn]);
    }
  }
  return selections.length ? JSON.stringify(selections.sort((a, b) =>
    a[0].localeCompare(b[0]) || a[1] - b[1] || a[2] - b[2],
  )) : null;
}
