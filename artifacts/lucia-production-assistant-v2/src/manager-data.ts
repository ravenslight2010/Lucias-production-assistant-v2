import type {
  ManagerManualRecipe,
  ManagerRecipeDefinition,
  ProductProfile,
  ProductProfileManagerData,
  ProductSetupDefaults,
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
export type ProductSetupEvidence = { value: string; source: string };
export type ImportedProductSetupEvidence = {
  lineCandidates: ProductSetupEvidence[];
  allergenEvidence: ProductSetupEvidence[];
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

function isProductSetupDefaults(value: unknown): value is ProductSetupDefaults {
  const setup = record(value);
  return Boolean(setup && (setup.line === null || typeof setup.line === 'string') &&
    (typeof setup.line !== 'string' || setup.line.length <= 120) &&
    Array.isArray(setup.allergens) && setup.allergens.every((item) => typeof item === 'string') &&
    setup.allergens.length <= 100 && setup.allergens.every((item) => item.trim().length > 0 && item.length <= 120) &&
    ['unreviewed', 'confirmed', 'not_applicable'].includes(String(setup.allergenReview)) &&
    !(setup.allergenReview === 'confirmed' && setup.allergens.length === 0) &&
    !(setup.allergenReview === 'not_applicable' && setup.allergens.length > 0));
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
    if (!result.productSetup && isProductSetupDefaults(content.productSetup)) {
      result.productSetup = content.productSetup;
    }
  }
  return result;
}

export function getImportedProductSetupEvidence(profile: ProductProfile): ImportedProductSetupEvidence {
  const result: ImportedProductSetupEvidence = { lineCandidates: [], allergenEvidence: [] };
  const seen = new Set<string>();
  const visited = new Set<object>();
  const add = (target: ProductSetupEvidence[], value: unknown, source: string) => {
    if (typeof value !== 'string' || !value.trim() ||
      target.length >= (target === result.lineCandidates ? 100 : 200)) return;
    const normalized = value.trim().slice(0, 1000);
    const sourceLabel = source.slice(0, 500) || 'Imported product data';
    const key = JSON.stringify([target === result.lineCandidates ? 'line' : 'allergen', normalized, sourceLabel]);
    if (seen.has(key)) return;
    seen.add(key);
    target.push({ value: normalized, source: sourceLabel });
  };
  const visit = (value: unknown, source: string, depth: number) => {
    if (!value || typeof value !== 'object' || visited.has(value) || depth > 18 || visited.size >= 4000) return;
    visited.add(value);
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, source, depth + 1));
      return;
    }
    const item = value as AnyRecord;
    const content = record(item.content);
    if (content?.format === MANAGER_FORMAT) return;
    const label = text(item.sourceName).trim() || text(item.importKind).trim() || source;
    for (const [key, child] of Object.entries(item)) {
      const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, '');
      if (['line', 'productionline', 'linename', 'lineassignment'].includes(normalizedKey)) {
        if (Array.isArray(child)) child.forEach((entry) => add(result.lineCandidates, entry, label));
        else add(result.lineCandidates, child, label);
      }
      if ((normalizedKey === 'allergen' || normalizedKey === 'allergens') &&
        (typeof child === 'string' || Array.isArray(child))) {
        if (Array.isArray(child)) child.forEach((entry) => add(result.allergenEvidence, entry, label));
        else add(result.allergenEvidence, child, label);
      }
      if (normalizedKey === 'notes' && Array.isArray(child)) {
        child.forEach((entry) => {
          if (typeof entry === 'string' && /\ballergen\b/i.test(entry)) add(result.allergenEvidence, entry, label);
        });
      }
      if (child && typeof child === 'object') visit(child, label, depth + 1);
    }
  };
  visit(profile.productData, 'Imported product data', 0);
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
  const premix = record(recipe.premix);
  const pullInstructions = Array.isArray(premix?.pullInstructions)
    ? premix.pullInstructions.flatMap((pullValue, index) => {
      const pull = record(pullValue);
      if (!pull) return [];
      const rawSourceRow = finite(pull.sourceRow);
      const sourceRow = rawSourceRow !== null && Number.isSafeInteger(rawSourceRow) &&
        rawSourceRow > 0 && rawSourceRow <= 1_000_000 ? rawSourceRow : null;
      const rawSourceColumn = text(pull.sourceColumn).trim();
      const sourceColumn = rawSourceColumn && rawSourceColumn.length <= 32 ? rawSourceColumn : null;
      const rawDaysEarly = numeric(pull.daysEarly);
      return [{
        id: `source-${sourceRow ?? 'unknown'}-${sourceColumn ?? 'unknown'}-${index + 1}`.slice(0, 80),
        text: text(pull.text),
        daysEarly: rawDaysEarly !== null && Number.isSafeInteger(rawDaysEarly) &&
          rawDaysEarly >= 0 && rawDaysEarly <= 3650 ? rawDaysEarly : null,
        sourceRow,
        sourceColumn,
      }];
    })
    : [];
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
    pullInstructions,
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
