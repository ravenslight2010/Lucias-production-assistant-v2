const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));

/** A new parser/source-sheet selection is distinct from a legacy guide import. */
export function sauceImportReviewIdentity(value: unknown): string | null {
  if (!record(value) || !record(value.structured) || value.structured.importKind !== "sauce_guide") return null;
  const data = value.structured;
  if (!Array.isArray(data.sheets)) throw new Error("Invalid sauce source.");
  const hasNewRecipe = data.sheets.some(s => record(s) && Array.isArray(s.recipes) && s.recipes.some(r => record(r) && r.sauce !== undefined));
  if (!hasNewRecipe) return null; // Existing preserved-source formats remain readable.
  if (!data.sheets.length || data.sheets.length > 100 ||
      !record(data.sauceReview) || typeof data.sauceReview.reviewedAsReference !== "boolean") throw new Error("Sauce source review is required.");
  const names: string[] = [];
  for (const sheet of data.sheets) {
    if (!record(sheet) || typeof sheet.name !== "string" || !sheet.name.trim() || sheet.name.length > 80 ||
        !Array.isArray(sheet.recipes) || sheet.recipes.length > 100) throw new Error("Invalid sauce sheet.");
    names.push(sheet.name);
    for (const recipe of sheet.recipes) {
      if (!record(recipe) || !record(recipe.sauce) || recipe.sauce.format !== "lucia.sauce-details.v1" ||
          recipe.sauce.referenceOnly !== true || !Array.isArray(recipe.sauce.issues) ||
          recipe.sauce.issues.length > 100 ||
          (recipe.sauce.issues.length > 0 && !data.sauceReview.reviewedAsReference)) throw new Error("Review sauce discrepancies.");
    }
  }
  if (new Set(names).size !== names.length) throw new Error("Duplicate sauce sheets.");
  return JSON.stringify(["lucia.sauce-details.v1", ...names.sort()]);
}
