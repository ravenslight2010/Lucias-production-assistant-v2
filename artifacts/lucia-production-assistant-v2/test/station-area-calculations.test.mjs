import test from 'node:test';
import assert from 'node:assert/strict';
import { calculationNeedsReview, getStationAreaCalculations } from '../src/station-area-calculations.ts';

const requirement = (id, overrides = {}) => ({
  id,
  name: id,
  source: 'Spec workbook · sheet 1 · row 2',
  originalName: id,
  station: 'Dough & sauce preparation',
  stationArea: 'dough_sauce_prep',
  directIngredient: false,
  recipeId: 'recipe-1',
  perPizza: 1,
  usageUnit: 'kg',
  totalRequired: 10,
  batchYield: 5,
  batchUnit: 'kg',
  batchesExact: 2,
  wholeBatches: 2,
  remainder: 0,
  amountColumn: 'Standard',
  ingredients: [],
  instructions: [],
  issues: [],
  ...overrides,
});

const current = (id, area, overrides = {}) => ({
  id,
  area,
  completedCases: 0,
  remainingCases: 10,
  remainingRequired: 10,
  remainingBatchesExact: 2,
  remainingWholeBatches: 2,
  remainingRemainder: 0,
  remainingIngredients: [],
  proposedUsage: [],
  ...overrides,
});

test('station calculator uses the captured shared batch total without repeating linked recipe lines', () => {
  const direct = requirement('direct', {
    directIngredient: true,
    recipeId: null,
    batchYield: null,
    batchUnit: null,
    batchesExact: null,
    wholeBatches: null,
    remainder: null,
  });
  const linkedSourceLine = requirement('source-use');
  const unresolved = requirement('unresolved', {
    recipeId: null,
    totalRequired: null,
    issues: ['Choose a confirmed formula.'],
  });
  const sharedBatch = requirement('batch:recipe-1:standard', { name: 'Brand sauce' });
  const plan = {
    items: [direct, linkedSourceLine, unresolved],
    batchPreparation: [sharedBatch],
  };
  const progress = {
    targetCases: 10,
    areas: [],
    items: [
      current('direct', 'dough_sauce_prep'),
      current('source-use', 'dough_sauce_prep'),
      current('unresolved', 'dough_sauce_prep'),
      current('batch:recipe-1:standard', 'dough_sauce_prep'),
      current('other-area', 'production_line'),
      current('no-area', null),
    ],
  };

  const rows = getStationAreaCalculations(plan, progress, 'dough_sauce_prep');

  assert.deepEqual(rows.map(({ item }) => item.id), [
    'direct',
    'unresolved',
    'batch:recipe-1:standard',
  ]);
  assert.equal(calculationNeedsReview(rows[1].item), true);
  assert.equal(calculationNeedsReview(rows[2].item), false);
});

test('station calculator returns no guessed values when plan or progress is unavailable', () => {
  assert.deepEqual(getStationAreaCalculations(null, null, 'production_line'), []);
  assert.deepEqual(
    getStationAreaCalculations({ items: [], batchPreparation: [] }, null, 'production_line'),
    [],
  );
});
