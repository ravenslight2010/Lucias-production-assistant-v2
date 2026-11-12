const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === "object" && !Array.isArray(v));

/** Keep corrected table projections distinct from legacy imports and retries idempotent. */
export function premixImportReviewIdentity(value: unknown): string | null {
  if (!record(value) || !record(value.structured) || value.structured.importKind !== "premix") return null;
  const data = value.structured;
  if (!Array.isArray(data.sheets)) throw new Error("Invalid premix source.");
  const hasNewRecipe = data.sheets.some(s => record(s) && Array.isArray(s.recipes) && s.recipes.some(r => record(r) && r.premix !== undefined));
  if (!hasNewRecipe) return null;
  if (!data.sheets.length || data.sheets.length > 100 ||
      !record(data.premixReview) || data.premixReview.reviewedAsReference !== true) throw new Error("Premix source review is required.");
  const keys: string[] = [], names: string[] = [];
  for (const sheet of data.sheets) {
    if (!record(sheet) || typeof sheet.name !== "string" || !sheet.name.trim() || sheet.name.length > 80 ||
        !Array.isArray(sheet.recipes) || sheet.recipes.length > 100) throw new Error("Invalid premix sheet.");
    names.push(sheet.name);
    for (const recipe of sheet.recipes) {
      if (!record(recipe) || !record(recipe.premix) || recipe.premix.format !== "lucia.premix-details.v1" ||
          recipe.premix.referenceOnly !== true || typeof recipe.premix.key !== "string" || recipe.premix.key.length > 300 ||
          !Array.isArray(recipe.premix.issues) || recipe.premix.issues.length > 100) throw new Error("Invalid premix recipe.");
      let coordinates: unknown;
      try { coordinates = JSON.parse(recipe.premix.key); } catch { throw new Error("Invalid premix source key."); }
      if (!Array.isArray(coordinates) || coordinates.length !== 3 || coordinates[0] !== sheet.name ||
          !Number.isSafeInteger(coordinates[1]) || coordinates[1] < 1 ||
          !Number.isSafeInteger(coordinates[2]) || coordinates[2] < 1) throw new Error("Invalid premix source key.");
      keys.push(recipe.premix.key);
    }
  }
  if (new Set(names).size !== names.length || new Set(keys).size !== keys.length) throw new Error("Duplicate premix source.");
  return JSON.stringify(["lucia.premix-details.v1", names.sort(), keys.sort()]);
}
