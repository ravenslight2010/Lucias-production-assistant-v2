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
    proposedUsage: ProposedIngredientUsage[];
  }[];
};

export type ProposedIngredientUsage = {
  id: string;
  requirementId: string;
  requirementName: string;
  ingredientName: string;
  unit: string;
  source: string;
  sourceAmount: number | null;
  quantityBasis: "per_pizza" | "per_batch" | "unresolved";
  amountColumn: string | null;
  batchColumn: number | null;
  proposedQuantity: number | null;
  blockedReason: string | null;
};

const inventoryUnits = new Set(["oz", "lb", "g", "kg", "each"]);

function round(value: number) {
  return Number(value.toFixed(6));
}

function sourceUsage(
  item: RunRequirementItem,
  completedCases: number | null,
  remainingRequired: number | null,
  remainingIngredients: RunIngredientRequirement[],
): ProposedIngredientUsage[] {
  const issues = Array.isArray(item.issues) ? item.issues : [];
  const directIngredient = item.directIngredient === true;
  const blockForNoCount = completedCases === null
    ? "A saved station count is required to estimate completed production."
    : null;
  const build = (
    ingredientName: string,
    unit: string,
    index: number,
    sourceAmount: number | null,
    quantityBasis: ProposedIngredientUsage["quantityBasis"],
    proposedQuantity: number | null,
    blockedReason: string | null,
  ): ProposedIngredientUsage => ({
    id: `${item.id}:usage:${index}`,
    requirementId: item.id,
    requirementName: item.originalName,
    ingredientName,
    unit,
    source: item.recipeSource
      ? `${item.source} · formula ${item.recipeSource}`
      : item.source,
    sourceAmount,
    quantityBasis,
    amountColumn: item.amountColumn,
    batchColumn: item.batchColumn,
    proposedQuantity,
    blockedReason,
  });

  if (directIngredient && !item.id.startsWith("batch:")) {
    const unit = item.usageUnit ?? "";
    const invalidUnit = !inventoryUnits.has(unit)
      ? "The saved source unit is missing or unsupported; no conversion was assumed."
      : null;
    const quantity = item.totalRequired === null || remainingRequired === null
      ? null
      : round(Math.max(0, item.totalRequired - remainingRequired));
    const reason = issues.length > 0
      ? issues.join(" ")
      : blockForNoCount ?? invalidUnit ?? (item.totalRequired === null
        ? "The saved plan has no resolved numeric quantity."
        : null);
    return [build(
      item.name,
      unit,
      0,
      item.perPizza,
      item.perPizza === null ? "unresolved" : "per_pizza",
      reason ? null : quantity,
      reason,
    )];
  }

  if (item.id.startsWith("batch:")) {
    if (item.ingredients.length === 0) {
      return [build(
        item.name,
        item.batchUnit ?? "",
        0,
        null,
        "unresolved",
        null,
        "The saved batch formula has no resolved ingredient quantities.",
      )];
    }
    return item.ingredients.map((ingredient, index) => {
      const remaining = remainingIngredients[index];
      const invalidUnit = !inventoryUnits.has(ingredient.unit)
        ? "The saved formula unit is missing or unsupported; no conversion was assumed."
        : null;
      const reason = issues.length > 0
        ? issues.join(" ")
        : blockForNoCount ?? invalidUnit ?? (remaining === undefined
          ? "The saved formula row no longer matches the run plan."
          : null);
      return build(
        ingredient.name,
        ingredient.unit,
        index,
        ingredient.perBatch,
        "per_batch",
        reason ? null : round(Math.max(0, ingredient.exactRequired - remaining.exactRequired)),
        reason,
      );
    });
  }

  if (issues.length > 0 || (!directIngredient && item.recipeId === null)) {
    return [build(
      item.name,
      item.usageUnit ?? "",
      0,
      item.perPizza ?? null,
      item.perPizza == null ? "unresolved" : "per_pizza",
      null,
      issues.join(" ") || "This requirement has no confirmed direct-ingredient or batch formula choice.",
    )];
  }
  return [];
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
    const proposedUsage = sourceUsage(
      item,
      completedCases,
      remainingRequired,
      remainingIngredients,
    );
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
      proposedUsage,
    };
  });
  return { targetCases: plan.targetCases, areas, items };
}
