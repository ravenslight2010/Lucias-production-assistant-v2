import type {
  ManagerManualRecipe,
  ManagerRecipeDefinition,
  ProductSetupDefaults,
  ProductProfileManagerData,
} from "@workspace/api-zod";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown) => typeof value === "string" ? value : "";

export const MANAGER_PROFILE_FORMAT = "lucia.manager-profile.v1";

export type ProductSetupEvidence = { value: string; source: string };
export type ImportedProductSetupEvidence = {
  lineCandidates: ProductSetupEvidence[];
  allergenEvidence: ProductSetupEvidence[];
};

const lineKeys = new Set(["line", "productionline", "linename", "lineassignment"]);

export function importedProductSetupEvidence(productData: unknown): ImportedProductSetupEvidence {
  const result: ImportedProductSetupEvidence = { lineCandidates: [], allergenEvidence: [] };
  const seen = new Set<string>();
  const visited = new Set<object>();
  const add = (target: ProductSetupEvidence[], value: unknown, source: string) => {
    if (typeof value !== "string" || !value.trim() ||
      target.length >= (target === result.lineCandidates ? 100 : 200)) return;
    const normalized = value.trim().slice(0, 1000);
    const sourceLabel = source.slice(0, 500) || "Imported product data";
    const key = JSON.stringify([target === result.lineCandidates ? "line" : "allergen", normalized, sourceLabel]);
    if (seen.has(key)) return;
    seen.add(key);
    target.push({ value: normalized, source: sourceLabel });
  };
  const visit = (value: unknown, source: string, depth: number) => {
    if (!value || typeof value !== "object" || visited.has(value) || depth > 18 || visited.size >= 4000) return;
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, source, depth + 1));
      return;
    }
    if (!record(value)) return;
    const content = record(value.content) ? value.content : null;
    if (content?.format === MANAGER_PROFILE_FORMAT) return;
    const label = text(value.sourceName).trim() || text(value.importKind).trim() || source;
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLocaleLowerCase().replace(/[^a-z]/g, "");
      if (lineKeys.has(normalizedKey)) {
        if (Array.isArray(child)) child.forEach((entry) => add(result.lineCandidates, entry, label));
        else add(result.lineCandidates, child, label);
      }
      if ((normalizedKey === "allergen" || normalizedKey === "allergens") &&
        (typeof child === "string" || Array.isArray(child))) {
        if (Array.isArray(child)) child.forEach((entry) => add(result.allergenEvidence, entry, label));
        else add(result.allergenEvidence, child, label);
      }
      if (normalizedKey === "notes" && Array.isArray(child)) {
        child.forEach((entry) => {
          if (typeof entry === "string" && /\ballergen\b/i.test(entry)) add(result.allergenEvidence, entry, label);
        });
      }
      if (child && typeof child === "object") visit(child, label, depth + 1);
    }
  };
  visit(productData, "Imported product data", 0);
  return result;
}

function isProductSetupDefaults(value: unknown): value is ProductSetupDefaults {
  if (!record(value) || !(value.line === null || typeof value.line === "string") ||
    (typeof value.line === "string" && value.line.length > 120) ||
    !Array.isArray(value.allergens) || value.allergens.length > 100 ||
    !value.allergens.every((item) => typeof item === "string" && item.trim().length > 0 && item.length <= 120) ||
    !["unreviewed", "confirmed", "not_applicable"].includes(text(value.allergenReview))) return false;
  if (value.allergenReview === "confirmed" && value.allergens.length === 0) return false;
  if (value.allergenReview === "not_applicable" && value.allergens.length > 0) return false;
  return true;
}

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
    if (!merged.productSetup && isProductSetupDefaults(content.productSetup)) {
      merged.productSetup = content.productSetup;
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
  const oldPremix = record(original.premix) ? original.premix : null;
  const premix = oldPremix && definition.pullInstructions !== undefined
    ? {
        ...oldPremix,
        pullInstructions: definition.pullInstructions.map((pull) => ({
          id: pull.id,
          text: pull.text,
          daysEarly: pull.daysEarly,
          sourceRow: pull.sourceRow,
          sourceColumn: pull.sourceColumn,
        })),
      }
    : oldPremix;
  return {
    ...original,
    ingredients: ingredientRows,
    total: { ...(record(original.total) ? original.total : {}), amounts: totals },
    ...(dough ? { dough } : {}),
    steps: definition.steps.map((step) => ({ text: step })),
    notes: definition.notes,
    ...(premix ? { premix } : {}),
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
    ...(recipe.category === "mix" ? {
      premix: {
        format: "lucia.premix-details.v1",
        section: "preparation",
        referenceOnly: true,
        pullInstructions: (definition.pullInstructions ?? []).map((pull) => ({
          id: pull.id,
          text: pull.text,
          daysEarly: pull.daysEarly,
          sourceRow: pull.sourceRow,
          sourceColumn: pull.sourceColumn,
        })),
      },
    } : {}),
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

