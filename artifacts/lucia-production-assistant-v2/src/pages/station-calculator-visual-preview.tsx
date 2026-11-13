import type {
  FacilityStationArea,
  RunRequirementItem,
  RunRequirementsProgress,
} from '@workspace/api-client-react';
import { StationAreaCalculator } from '@/components/station-area-calculator';
import type { StationRequirementsSource } from '@/station-area-calculations';

function batchRecipe(id: string, name: string, stationArea: FacilityStationArea): RunRequirementItem {
  return {
    id,
    name,
    originalName: name,
    source: 'Cheese Mix Recipe Specs · Lucia tab · row 12',
    station: stationArea === 'dough_sauce_prep' ? 'Dough & sauce preparation' : 'Production line',
    stationArea,
    amountChoices: [],
    amountColumn: 'Standard',
    usageUnit: 'kg',
    perPizza: 0.018,
    totalRequired: 18,
    recipeId: `recipe-${id}`,
    recipeSource: 'Cheese Mix Recipe Specs · Lucia tab',
    directIngredient: false,
    batchColumn: 0,
    batchUnit: 'kg',
    batchYield: 9,
    batchesExact: 2,
    wholeBatches: 2,
    remainder: 0,
    ingredients: [{
      name: 'Shredded cheese blend',
      unit: 'kg',
      perBatch: 9,
      exactRequired: 18,
      wholeBatchRequired: 18,
    }],
    instructions: ['Keep the blend refrigerated until the production run.'],
    issues: [],
  };
}

function directIngredient(id: string, name: string, stationArea: FacilityStationArea): RunRequirementItem {
  return {
    id,
    name,
    originalName: name,
    source: 'Pizza Recipe Specs · Brand tab · row 8',
    station: stationArea === 'dough_sauce_prep' ? 'Dough & sauce preparation' : 'Production line',
    stationArea,
    amountChoices: [],
    amountColumn: 'Per pizza',
    usageUnit: 'g',
    perPizza: 120,
    totalRequired: 120_000,
    recipeId: null,
    recipeSource: null,
    directIngredient: true,
    batchColumn: null,
    batchUnit: null,
    batchYield: null,
    batchesExact: null,
    wholeBatches: null,
    remainder: null,
    ingredients: [],
    instructions: [],
    issues: [],
  };
}

const sauceBatch = batchRecipe('batch:sauce:standard', 'Lucia tomato sauce', 'dough_sauce_prep');
const cheeseBatch = batchRecipe('batch:cheese:standard', 'Lucia cheese blend', 'production_line');
const mozzarella = directIngredient('direct:mozzarella', 'Mozzarella topping', 'production_line');
const unresolved: RunRequirementItem = {
  ...directIngredient('unresolved:oil', 'Finishing oil', 'production_line'),
  directIngredient: false,
  recipeId: null,
  totalRequired: null,
  batchYield: null,
  batchesExact: null,
  wholeBatches: null,
  remainder: null,
  issues: ['Choose a confirmed process formula.'],
};

const plan: StationRequirementsSource = {
  items: [sauceBatch, cheeseBatch, mozzarella, unresolved],
  batchPreparation: [sauceBatch, cheeseBatch],
};

const progress: RunRequirementsProgress = {
  targetCases: 100,
  areas: [
    { area: 'dough_sauce_prep', stationCount: 2, completedCases: 42, remainingCases: 58 },
    { area: 'production_line', stationCount: 3, completedCases: 60, remainingCases: 40 },
    { area: 'freezing_packaging', stationCount: 1, completedCases: null, remainingCases: null },
    { area: 'warehouse', stationCount: 1, completedCases: null, remainingCases: null },
  ],
  items: [
    {
      id: sauceBatch.id,
      area: 'dough_sauce_prep',
      completedCases: 42,
      remainingCases: 58,
      remainingRequired: 10.44,
      remainingBatchesExact: 1.16,
      remainingWholeBatches: 2,
      remainingRemainder: 7.56,
      remainingIngredients: [{ name: 'Tomato base', unit: 'kg', perBatch: 9, exactRequired: 10.44, wholeBatchRequired: 18 }],
      proposedUsage: [],
    },
    {
      id: cheeseBatch.id,
      area: 'production_line',
      completedCases: 60,
      remainingCases: 40,
      remainingRequired: 7.2,
      remainingBatchesExact: 0.8,
      remainingWholeBatches: 1,
      remainingRemainder: 1.8,
      remainingIngredients: [{ name: 'Shredded cheese blend', unit: 'kg', perBatch: 9, exactRequired: 7.2, wholeBatchRequired: 9 }],
      proposedUsage: [],
    },
    {
      id: mozzarella.id,
      area: 'production_line',
      completedCases: 60,
      remainingCases: 40,
      remainingRequired: 48_000,
      remainingBatchesExact: null,
      remainingWholeBatches: null,
      remainingRemainder: null,
      remainingIngredients: [],
      proposedUsage: [],
    },
    {
      id: unresolved.id,
      area: 'production_line',
      completedCases: 60,
      remainingCases: 40,
      remainingRequired: null,
      remainingBatchesExact: null,
      remainingWholeBatches: null,
      remainingRemainder: null,
      remainingIngredients: [],
      proposedUsage: [],
    },
  ],
};

const previewAreas: FacilityStationArea[] = ['dough_sauce_prep', 'production_line', 'freezing_packaging'];

export default function StationCalculatorVisualPreviewPage() {
  return (
    <main className="workspace" style={{ maxWidth: 1040, marginInline: 'auto', paddingBlock: 24 }}>
      <div className="page-head">
        <div>
          <div className="eyebrow">Development-only component preview</div>
          <h1>Station production calculations</h1>
          <p className="page-subtitle">Synthetic data only. Shared remaining needs follow saved area counts and captured run formulas; this preview cannot save changes.</p>
        </div>
      </div>
      <section className="panel run-station-progress" aria-label="Station production calculation examples">
        {previewAreas.map((area) => (
          <section className="run-station-area" key={area}>
            <h3>{area.replaceAll('_', ' ')}</h3>
            <StationAreaCalculator
              area={area}
              plan={plan}
              progress={progress}
              defaultOpen
            />
          </section>
        ))}
      </section>
    </main>
  );
}
