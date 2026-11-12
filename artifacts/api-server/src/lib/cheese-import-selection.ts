const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const positive = (value: unknown, max: number) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max;

/** Keep legacy identities; bind reviewed cheese imports to the exact selected formulas. */
export function cheeseImportSelectionIdentity(value: unknown): string | null {
  if (!record(value) || !record(value.structured) || value.structured.importKind !== "cheese") return null;
  const data = value.structured;
  if (data.cheeseSelection === undefined) {
    const hasNewRecipes = Array.isArray(data.sheets) && data.sheets.some(sheet =>
      record(sheet) && Array.isArray(sheet.recipes) && sheet.recipes.some(recipe => record(recipe) && record(recipe.cheese)),
    );
    if (hasNewRecipes) throw new Error("Cheese formula selection is required.");
    return null;
  }
  const selection = data.cheeseSelection;
  if (!record(selection) || typeof selection.reviewedAsReference !== "boolean" ||
      !Array.isArray(selection.keys) || !selection.keys.length || selection.keys.length > 100 ||
      !selection.keys.every(key => typeof key === "string" && key.length <= 200) ||
      new Set(selection.keys).size !== selection.keys.length ||
      !Array.isArray(data.sheets) || data.sheets.length !== 1) throw new Error("Invalid cheese selection.");
  const sheet = data.sheets[0];
  if (!record(sheet) || typeof sheet.name !== "string" || sheet.name.length > 80 ||
      !Array.isArray(sheet.recipes) || sheet.recipes.length !== selection.keys.length) throw new Error("Invalid cheese formulas.");
  const keys: string[] = [];
  for (const recipe of sheet.recipes) {
    if (!record(recipe) || !record(recipe.cheese)) throw new Error("Invalid cheese formula.");
    const cheese = recipe.cheese;
    const key = JSON.stringify([sheet.name, cheese.headerRow, cheese.sourceColumn]);
    if (cheese.format !== "lucia.cheese-details.v1" || cheese.brand !== sheet.name ||
        typeof cheese.sourceName !== "string" || !cheese.sourceName.trim() || cheese.sourceName.length > 2000 ||
        recipe.name !== `${sheet.name} — ${cheese.sourceName}` ||
        !positive(cheese.headerRow, 20_000) || !positive(cheese.sourceColumn, 300) ||
        cheese.key !== key || !selection.keys.includes(key) ||
        !Array.isArray(cheese.issues) || (cheese.issues.length > 0 && !selection.reviewedAsReference) ||
        !record(recipe.source) || recipe.source.sheet !== sheet.name ||
        !Array.isArray(recipe.ingredients) || !recipe.ingredients.length || recipe.ingredients.length > 100) {
      throw new Error("Invalid or unreviewed cheese formula.");
    }
    const validAmounts = (ingredient: unknown) => record(ingredient) && Array.isArray(ingredient.amounts) &&
      ingredient.amounts.length <= 1 && ingredient.amounts.every(amount => record(amount) &&
        amount.column === cheese.sourceColumn && amount.label === "LBS" &&
        (typeof amount.value === "string" || (typeof amount.value === "number" && Number.isFinite(amount.value))),
      );
    if (!recipe.ingredients.every(validAmounts) || (recipe.total !== undefined && !validAmounts(recipe.total))) {
      throw new Error("Cheese weights do not match the selected source column.");
    }
    keys.push(key);
  }
  if (new Set(keys).size !== keys.length) throw new Error("Duplicate cheese formulas.");
  return JSON.stringify(keys.sort());
}
