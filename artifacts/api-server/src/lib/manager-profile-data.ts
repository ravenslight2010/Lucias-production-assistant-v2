import type {
  ManagerManualRecipe,
  ManagerRecipeDefinition,
  ProductProfileManagerData,
} from "@workspace/api-zod";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown) => typeof value === "string" ? value : "";

export const MANAGER_PROFILE_FORMAT = "lucia.manager-profile.v1";

export function managerProfileData(productData: unknown): ProductProfileManagerData {
  const merged: ProductProfileManagerData = { recipeOverrides: {}, manualRecipes: [] };
  if (!record(productData) || !Array.isArray(productData.sources)) return merged;
  const seenManual = new Set<string>();
  for (const source of productData.sources) {
    if (!record(source) || !record(source.content) || source.content.format !== MANAGER_PROFILE_FORMAT) continue;
    const content = source.content;
    if (record(content.recipeOverrides)) {
      Object.assign(merged.recipeOverrides, content.recipeOverrides);
    }
    if (Array.isArray(content.manualRecipes)) {
      for (const recipe of content.manualRecipes) {
        if (!record(recipe) || typeof recipe.id !== "string" || seenManual.has(recipe.id)) continue;
        seenManual.add(recipe.id);
        merged.manualRecipes.push(recipe as unknown as ManagerManualRecipe);
      }
    }
    // When profiles are merged, the target's source entries remain first.
    // Keep its reviewed defaults; recipe records from both profiles still merge.
    if (!merged.setupDefaults && record(content.setupDefaults)) {
      merged.setupDefaults = content.setupDefaults as ProductProfileManagerData["setupDefaults"];
    }
  }
  return merged;
}

export function managerRecipeSourceKey(input: {
  profileId: string;
  sourceName: string;
  importKind: string;
  sheet: string;
  row: number;
  name: string;
}) {
  return JSON.stringify([
    input.profileId,
    input.sourceName,
    input.importKind,
    input.sheet,
    input.row,
    input.name,
  ]);
}

export function applyManagerRecipeDefinition<T extends RecordValue>(
  original: T,
  definition: ManagerRecipeDefinition,
): T {
  const ingredientRows = definition.ingredients.map((ingredient) => ({
    ...ingredient,
    amounts: ingredient.amounts.map((amount) => ({
      column: amount.column,
      value: amount.amount === null ? "" : String(amount.amount),
      label: amount.unit ?? "",
    })),
  }));
  const totals = definition.batchVariants.map((variant) => ({
    column: variant.column,
    value: variant.yield === null ? "" : String(variant.yield),
    label: variant.unit ?? variant.label,
  }));
  const oldDough = record(original.dough) ? original.dough : null;
  const dough = oldDough
    ? { ...oldDough, batches: definition.batchVariants.map((variant) => ({
        column: variant.column,
        label: variant.label,
        unit: variant.unit,
        total: variant.yield,
      })) }
    : undefined;
  return {
    ...original,
    ingredients: ingredientRows,
    total: { ...(record(original.total) ? original.total : {}), amounts: totals },
    ...(dough ? { dough } : {}),
    steps: definition.steps.map((step) => ({ text: step })),
    notes: definition.notes,
  } as T;
}

export function manualRecipeRaw(recipe: ManagerManualRecipe): RecordValue {
  const definition = recipe.recipeData;
  const ingredients = definition.ingredients.map((ingredient) => ({
    name: ingredient.name,
    amounts: ingredient.amounts.map((amount) => ({
      column: amount.column,
      value: amount.amount === null ? "" : String(amount.amount),
      label: amount.unit ?? "",
    })),
  }));
  const totals = definition.batchVariants.map((variant) => ({
    column: variant.column,
    value: variant.yield === null ? "" : String(variant.yield),
    label: variant.unit ?? variant.label,
  }));
  return {
    name: recipe.name,
    source: { sheet: "Manager recipe library", startRow: 1 },
    ingredients,
    total: { amounts: totals },
    ...(recipe.category === "dough" ? {
      dough: {
        batches: definition.batchVariants.map((variant) => ({
          column: variant.column,
          label: variant.label,
          unit: variant.unit,
          total: variant.yield,
        })),
      },
    } : {}),
    steps: definition.steps.map((step) => ({ text: step })),
    notes: definition.notes,
  };
}

export function categoryImportKind(category: ManagerManualRecipe["category"]) {
  return ({
    cheese: "cheese",
    mix: "premix",
    dough: "dough_guide",
    sauce: "sauce_guide",
  } as const)[category];
}

export function managerDataSource(input: {
  profileId: string;
  brand: string;
  flavor: string;
  managerData: ProductProfileManagerData;
}) {
  return {
    profileId: input.profileId,
    brand: input.brand,
    flavor: input.flavor,
    importKind: "manager_profile",
    sourceName: "Manager profile setup",
    content: { format: MANAGER_PROFILE_FORMAT, ...input.managerData },
  };
}

