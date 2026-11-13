import type {
  ManagerManualRecipe,
  ManagerRecipeDefinition,
  ProductProfile,
  ProductProfileManagerData,
} from '@workspace/api-client-react';

export const MANAGER_FORMAT = 'lucia.manager-profile.v1';

type AnyRecord = Record<string, unknown>;
export type ImportedRecipe = {
  sourceKey: string;
  name: string;
  category: 'cheese' | 'mix' | 'dough' | 'sauce';
  sourceName: string;
  importKind: string;
  sheet: string;
  row: number;
  definition: ManagerRecipeDefinition;
};

const record = (value: unknown): AnyRecord | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as AnyRecord : null;
const text = (value: unknown, fallback = ''): string =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const numeric = (value: unknown): number | null => {
  const parsed = typeof value === 'string' && value.trim() !== '' && /^[-+]?\d+(?:\.\d+)?$/.test(value.trim())
    ? Number(value)
    : value;
  return finite(parsed);
};

export function emptyManagerData(): ProductProfileManagerData {
  return { recipeOverrides: {}, manualRecipes: [] };
}

export function getManagerData(profile: ProductProfile): ProductProfileManagerData {
  const data = record(profile.productData);
  const sources = Array.isArray(data?.sources) ? data.sources : [];
  const result = emptyManagerData();
  const seenManual = new Set<string>();
  for (const sourceValue of sources) {
    const source = record(sourceValue);
    const content = record(source?.content);
    if (content?.format !== MANAGER_FORMAT) continue;
    const overrides = record(content.recipeOverrides);
    const manualRecipes = Array.isArray(content.manualRecipes) ? content.manualRecipes : [];
    if (overrides) Object.assign(result.recipeOverrides, overrides);
    for (const item of manualRecipes) {
      const itemRecord = record(item);
      if (!itemRecord || typeof itemRecord.id !== 'string' || seenManual.has(itemRecord.id) ||
        !['cheese', 'mix', 'dough', 'sauce'].includes(String(itemRecord.category)) ||
        !record(itemRecord.recipeData)) continue;
      seenManual.add(itemRecord.id);
      result.manualRecipes.push(itemRecord as unknown as ManagerManualRecipe);
    }
    // Merged profile source entries keep the survivor first; preserve its reviewed defaults.
    if (!result.setupDefaults && record(content.setupDefaults)) {
      result.setupDefaults = content.setupDefaults as ProductProfileManagerData['setupDefaults'];
    }
  }
  return result;
}

function categoryFor(importKind: string): ImportedRecipe['category'] | null {
  if (importKind === 'cheese') return 'cheese';
  if (importKind === 'premix') return 'mix';
  if (importKind === 'dough_guide') return 'dough';
  if (importKind === 'sauce_guide') return 'sauce';
  return null;
}

function managerDefinition(recipeValue: unknown): ManagerRecipeDefinition {
  const recipe = record(recipeValue) ?? {};
  const ingredients = Array.isArray(recipe.ingredients) ? recipe.ingredients : [];
  const metrics = Array.isArray(recipe.metrics) ? recipe.metrics : [];
  const dough = record(recipe.dough);
  const doughBatches = Array.isArray(dough?.batches) ? dough.batches : [];
  const batchMetrics = doughBatches.length ? [] : [...metrics, ...(record(recipe.total) ? [recipe.total] : [])];
  const batchVariants = doughBatches.length ? doughBatches.flatMap((batchValue) => {
    const batch = record(batchValue);
    const column = finite(batch?.column);
    if (column === null) return [];
    return [{
      column,
      label: text(batch?.label, `Column ${column}`),
      unit: text(batch?.unit) || null,
      yield: numeric(batch?.total),
    }];
  }) : batchMetrics.flatMap((metricValue) => {
    const metric = record(metricValue);
    const amounts = Array.isArray(metric?.amounts) ? metric.amounts : [];
    return amounts.flatMap((amountValue) => {
      const amount = record(amountValue);
      const column = finite(amount?.column);
      if (column === null) return [];
      return [{
        column,
        label: text(amount?.label, `Column ${column}`),
        unit: null,
        yield: numeric(amount?.value),
      }];
    });
  });
  const uniqueVariants = [...new Map(batchVariants.map((item) => [item.column, item])).values()];
  return {
    batchVariants: uniqueVariants.length ? uniqueVariants : [{ column: 1, label: 'Batch 1', unit: null, yield: null }],
    ingredients: ingredients.flatMap((ingredientValue, index) => {
      const ingredient = record(ingredientValue);
      if (!ingredient) return [];
      const amounts = Array.isArray(ingredient.amounts) ? ingredient.amounts : [];
      return [{
        id: `ingredient-${index + 1}`,
        name: text(ingredient.name, `Ingredient ${index + 1}`),
        amounts: amounts.flatMap((amountValue) => {
          const amount = record(amountValue);
          const column = finite(amount?.column);
          if (column === null) return [];
          const numericAmount = numeric(amount?.value);
          return [{ column, amount: numericAmount, unit: text(amount?.label) || null }];
        }),
      }];
    }),
    steps: (Array.isArray(recipe.steps) ? recipe.steps : []).map((step) => {
      const item = record(step);
      return text(item?.text);
    }).filter(Boolean),
    notes: (Array.isArray(recipe.notes) ? recipe.notes : []).filter((note): note is string => typeof note === 'string'),
  };
}

export function extractImportedRecipes(profile: ProductProfile): ImportedRecipe[] {
  const found: ImportedRecipe[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number, meta: { sourceName: string; importKind: string; profileId: string }) => {
    if (depth > 12 || !value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, depth + 1, meta));
      return;
    }
    const item = value as AnyRecord;
    const sourceName = text(item.sourceName, meta.sourceName);
    const importKind = text(item.importKind, meta.importKind);
    const sourceProfileId = text(item.profileId, meta.profileId);
    if (item.format === 'lucia.operational-workbook.v1' && Array.isArray(item.sheets)) {
      const category = categoryFor(importKind);
      if (category) {
        for (const sheetValue of item.sheets) {
          const sheet = record(sheetValue);
          if (!sheet || typeof sheet.name !== 'string' || !Array.isArray(sheet.recipes)) continue;
          for (const [recipeIndex, recipeValue] of sheet.recipes.entries()) {
            const recipe = record(recipeValue);
            if (!recipe) continue;
            const recipeName = text(recipe.name, 'Unnamed recipe');
            const sourceCoords = record(recipe.source);
            const row = finite(sourceCoords?.startRow) ?? finite(sourceCoords?.row) ?? finite(recipe.sourceRow) ?? recipeIndex + 1;
            const sourceKey = JSON.stringify([sourceProfileId, sourceName, importKind, sheet.name, row, recipeName]);
            found.push({
              sourceKey, name: recipeName, category, sourceName, importKind,
              sheet: sheet.name, row, definition: managerDefinition(recipeValue),
            });
          }
        }
        return;
      }
    }
    for (const key of ['sources', 'content', 'structured', 'data']) {
      if (key in item) visit(item[key], depth + 1, { sourceName, importKind, profileId: sourceProfileId });
    }
  };
  visit(profile.productData, 0, { sourceName: 'Imported workbook', importKind: '', profileId: profile.id });
  return found;
}
