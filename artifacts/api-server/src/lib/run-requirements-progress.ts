import type {
  FacilityStationArea,
  RunIngredientRequirement,
  RunRequirementItem,
  RunRequirementsPlan,
} from "@workspace/api-zod";

export type RunRequirementsProgress = {
  targetCases: number;
  areas: {
    area: FacilityStationArea;
    stationCount: number;
    completedCases: number | null;
    remainingCases: number | null;
  }[];
  items: {
    id: string;
    area: FacilityStationArea | null;
    completedCases: number | null;
    remainingCases: number | null;
    remainingRequired: number | null;
    remainingBatchesExact: number | null;
    remainingWholeBatches: number | null;
    remainingRemainder: number | null;
    remainingIngredients: RunIngredientRequirement[];
  }[];
};

function round(value: number) {
  return Number(value.toFixed(6));
}

function requirementArea(item: RunRequirementItem): FacilityStationArea | null {
  if (item.stationArea) return item.stationArea;
  if (item.station === "Dough & sauce preparation") return "dough_sauce_prep";
  if (item.station === "Production line") return "production_line";
  return null;
}

/**
 * Scales only the captured, reviewed plan. It never rereads current profile data
 * or modifies imported source quantities/formulas.
 */
export function calculateRunRequirementsProgress(
  plan: RunRequirementsPlan,
  stationCounts: Array<{
    area: FacilityStationArea;
    completedCases: number;
    recorded: boolean;
  }>,
): RunRequirementsProgress {
  const areaOrder: FacilityStationArea[] = [
    "dough_sauce_prep",
    "production_line",
    "freezing_packaging",
    "warehouse",
  ];
  const areas = areaOrder.map((area) => {
    const counts = stationCounts
      .filter((station) => station.area === area && station.recorded)
      .map((station) => station.completedCases);
    const completedCases = counts.length ? Math.min(...counts) : null;
    return {
      area,
      stationCount: counts.length,
      completedCases,
      remainingCases: completedCases === null
        ? null
        : Math.max(0, plan.targetCases - completedCases),
    };
  });
  const areaById = new Map(areas.map((area) => [area.area, area]));
  const planItems = [...plan.items, ...plan.batchPreparation];
  const items = planItems.map((item) => {
    const area = requirementArea(item);
    const areaProgress = area ? areaById.get(area) : undefined;
    const completedCases = areaProgress?.completedCases ?? null;
    const remainingCases = areaProgress?.remainingCases ?? null;
    const ratio = remainingCases === null ? null : remainingCases / plan.targetCases;
    const remainingRequired = ratio === null || item.totalRequired === null
      ? null
      : round(item.totalRequired * ratio);
    const remainingBatchesExact = ratio === null || item.batchesExact === null
      ? null
      : round(item.batchesExact * ratio);
    const remainingWholeBatches = remainingBatchesExact === null
      ? null
      : Math.ceil(remainingBatchesExact);
    const remainingRemainder =
      remainingBatchesExact === null ||
      remainingWholeBatches === null ||
      item.batchYield === null
        ? null
        : round(
            remainingWholeBatches * item.batchYield -
              remainingBatchesExact * item.batchYield,
          );
    const remainingIngredients: RunIngredientRequirement[] =
      remainingBatchesExact === null || remainingWholeBatches === null
        ? []
        : item.ingredients.map((ingredient) => ({
            ...ingredient,
            exactRequired: round(ingredient.perBatch * remainingBatchesExact),
            wholeBatchRequired: round(ingredient.perBatch * remainingWholeBatches),
          }));
    return {
      id: item.id,
      area,
      completedCases,
      remainingCases,
      remainingRequired,
      remainingBatchesExact,
      remainingWholeBatches,
      remainingRemainder,
      remainingIngredients,
    };
  });
  return { targetCases: plan.targetCases, areas, items };
}
