import type {
  FacilityStationArea,
  RunRequirementItem,
  RunRequirementProgressItem,
  RunRequirementsPlan,
  RunRequirementsProgress,
} from '@workspace/api-client-react';

export type StationAreaCalculation = {
  item: RunRequirementItem;
  progress: RunRequirementProgressItem;
};

export type StationRequirementsSource = Pick<
  RunRequirementsPlan,
  'items' | 'batchPreparation'
>;

/**
 * Show each source line or approved shared batch total once in its mapped area.
 * Resolved recipe source lines are represented by batchPreparation instead of
 * being repeated as independent batch calculations.
 */
export function getStationAreaCalculations(
  plan: StationRequirementsSource | null | undefined,
  progress: RunRequirementsProgress | null | undefined,
  area: FacilityStationArea,
): StationAreaCalculation[] {
  if (!plan || !progress) return [];

  const displayItems = [
    ...plan.items.filter((item) => !item.recipeId || item.issues.length > 0),
    ...plan.batchPreparation,
  ];
  const itemById = new Map(displayItems.map((item) => [item.id, item]));

  return progress.items.flatMap((current) => {
    if (current.area !== area) return [];
    const item = itemById.get(current.id);
    return item ? [{ item, progress: current }] : [];
  });
}

export function calculationNeedsReview(item: RunRequirementItem): boolean {
  return (
    item.issues.length > 0 ||
    (!item.directIngredient && item.recipeId === null) ||
    item.totalRequired === null ||
    (!item.directIngredient && (item.batchYield === null || item.wholeBatches === null))
  );
}
