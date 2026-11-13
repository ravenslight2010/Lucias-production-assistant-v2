import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractImportedRecipes, getManagerData } from '../src/manager-data.ts';

const managerSource = (content) => ({
  importKind: 'manager_profile',
  sourceName: 'Manager profile setup',
  content: { format: 'lucia.manager-profile.v1', ...content },
});

test('manager recipe identity follows the original merged source profile and worksheet row', () => {
  const profile = {
    id: 'survivor-profile',
    brand: 'Lucia',
    flavor: 'Original',
    revision: 4,
    productData: { sources: [{
      profileId: 'source-profile',
      brand: 'Lucia',
      flavor: 'Original',
      sourceName: 'dough.xlsx',
      importKind: 'dough_guide',
      content: {
        format: 'lucia.operational-workbook.v1',
        importKind: 'dough_guide',
        sheets: [{
          name: 'Mixing Procedure',
          recipes: [{
            name: 'Lucia Dough',
            source: { sheet: 'Mixing Procedure', startRow: 19 },
            dough: { batches: [{ column: 3, label: '2 Bag', unit: 'lb', total: 40 }] },
            ingredients: [{ name: 'Flour', amounts: [{ column: 3, value: 20, label: 'lb' }] }],
            steps: [{ text: 'Mix until smooth.' }],
            notes: ['Keep chilled.'],
          }],
        }],
      },
    }] },
  };
  const [recipe] = extractImportedRecipes(profile);
  assert.equal(recipe.category, 'dough');
  assert.equal(recipe.sourceKey, JSON.stringify([
    'source-profile', 'dough.xlsx', 'dough_guide', 'Mixing Procedure', 19, 'Lucia Dough',
  ]));
  assert.equal(recipe.definition.batchVariants[0].yield, 40);
  assert.equal(recipe.definition.ingredients[0].amounts[0].amount, 20);
  assert.equal(recipe.definition.steps[0], 'Mix until smooth.');
});

test('manager recipe extraction retains premix pull text, timing, and source coordinates', () => {
  const profile = {
    id: 'mix-profile',
    brand: 'Lucia',
    flavor: 'Garlic',
    revision: 1,
    productData: { sources: [{
      sourceName: 'Mixes.xlsx',
      importKind: 'premix',
      content: {
        format: 'lucia.operational-workbook.v1',
        importKind: 'premix',
        sheets: [{
          name: 'Pulls',
          recipes: [{
            name: 'Garlic Mix',
            source: { startRow: 8 },
            premix: {
              pullInstructions: [
                { text: 'Move to cooler', sourceRow: 17, sourceColumn: 'B', daysEarly: 2 },
                { text: 'Check before use', sourceRow: 18, sourceColumn: 'C' },
              ],
            },
          }],
        }],
      },
    }] },
  };

  const [recipe] = extractImportedRecipes(profile);

  assert.equal(recipe.category, 'mix');
  assert.deepEqual(recipe.definition.pullInstructions, [
    {
      id: 'source-17-B-1',
      text: 'Move to cooler',
      daysEarly: 2,
      sourceRow: 17,
      sourceColumn: 'B',
    },
    {
      id: 'source-18-C-2',
      text: 'Check before use',
      daysEarly: null,
      sourceRow: 18,
      sourceColumn: 'C',
    },
  ]);
});

test('manager data merges recipe edits from merged profiles and keeps survivor setup defaults', () => {
  const firstManual = { id: 'manual-one', category: 'cheese', brand: 'Lucia', flavor: 'Original', name: 'Cheese One', recipeData: {} };
  const secondManual = { id: 'manual-two', category: 'sauce', brand: 'Lucia', flavor: 'Original', name: 'Sauce Two', recipeData: {} };
  const profile = {
    id: 'survivor-profile',
    brand: 'Lucia',
    flavor: 'Original',
    revision: 5,
    productData: { sources: [
      managerSource({ recipeOverrides: { survivor: { notes: ['target'] } }, manualRecipes: [firstManual], setupDefaults: { unitsPerCase: 12 } }),
      managerSource({ recipeOverrides: { merged: { notes: ['source'] } }, manualRecipes: [secondManual], setupDefaults: { unitsPerCase: 24 } }),
    ] },
  };
  const data = getManagerData(profile);
  assert.deepEqual(Object.keys(data.recipeOverrides).sort(), ['merged', 'survivor']);
  assert.deepEqual(data.manualRecipes.map((recipe) => recipe.id), ['manual-one', 'manual-two']);
  assert.equal(data.setupDefaults.unitsPerCase, 12);
});
