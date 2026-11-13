import { useMemo } from 'react';
import type {
  FacilityStationArea,
  RunRequirementsProgress,
} from '@workspace/api-client-react';
import {
  calculationNeedsReview,
  getStationAreaCalculations,
  type StationRequirementsSource,
} from '@/station-area-calculations';
import './run-station-progress.css';

const areaLabels: Record<FacilityStationArea, string> = {
  dough_prep: 'Dough prep',
  sauce_prep: 'Sauce prep',
  dough_sauce_prep: 'Dough & sauce prep',
  production_line: 'Production line',
  freeze_tunnel: 'Freeze tunnel',
  freezing_packaging: 'Wrapper & packing',
  warehouse: 'Warehouse',
};

function formatQuantity(value: number | null) {
  if (value === null) return '—';
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 6 }).format(value);
}

export function StationAreaCalculator({
  area,
  plan,
  progress,
  defaultOpen = false,
}: {
  area: FacilityStationArea;
  plan: StationRequirementsSource;
  progress: RunRequirementsProgress;
  defaultOpen?: boolean;
}) {
  const calculations = useMemo(
    () => getStationAreaCalculations(plan, progress, area),
    [plan, progress, area],
  );

  return (
    <details
      className="run-station-calculator"
      data-testid={`details-station-calculator-${area}`}
      open={defaultOpen ? true : undefined}
    >
      <summary>
        <span>
          <strong>Live area calculations</strong>
          <small>Shared prep needs for {areaLabels[area].toLowerCase()}</small>
        </span>
        <span className="run-station-calculator-count">
          {calculations.length} {calculations.length === 1 ? 'line' : 'lines'}
        </span>
      </summary>
      <div className="run-station-calculator-body">
        <p className="field-help">
          These are shared area totals, not separate amounts for each station. Remaining needs use the lowest saved case count in this area and the captured run formulas. They do not deduct inventory.
        </p>
        {calculations.length === 0 ? (
          <p className="field-help">No source-backed calculation lines are mapped to this area.</p>
        ) : (
          <div className="run-station-calculation-list">
            {calculations.map(({ item, progress: live }) => {
              const needsReview = calculationNeedsReview(item);
              return (
                <article
                  className="run-station-calculation"
                  key={item.id}
                  data-testid={`card-station-calculation-${area}-${item.id}`}
                >
                  <div className="run-station-calculation-title">
                    <strong>{item.name}</strong>
                    <small>{item.source}{item.originalName !== item.name ? ` · source name "${item.originalName}"` : ''}</small>
                  </div>
                  {needsReview ? (
                    <div className="run-station-calculation-review" role="note">
                      <strong>Needs review</strong>
                      <span>No preparation amount is shown until this source line has a confirmed calculation.</span>
                      {item.issues.length > 0 && <ul>{item.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
                    </div>
                  ) : live.completedCases === null ? (
                    <p className="run-station-calculation-unavailable">
                      Save a case count for a station in this area to calculate remaining needs.
                    </p>
                  ) : (
                    <>
                      <div className="run-station-calculation-metrics">
                        <div>
                          <span>Cases remaining</span>
                          <strong>{formatQuantity(live.remainingCases)} / {progress.targetCases}</strong>
                        </div>
                        {item.directIngredient ? (
                          <div>
                            <span>Remaining amount</span>
                            <strong>{formatQuantity(live.remainingRequired)} {item.usageUnit ?? ''}</strong>
                          </div>
                        ) : (
                          <>
                            <div>
                              <span>Whole batches</span>
                              <strong>{formatQuantity(live.remainingWholeBatches)} {item.batchUnit ?? ''}</strong>
                            </div>
                            <div>
                              <span>Exact batches</span>
                              <strong>{formatQuantity(live.remainingBatchesExact)}</strong>
                            </div>
                          </>
                        )}
                      </div>
                      {!item.directIngredient && live.remainingIngredients.length > 0 && (
                        <div className="run-station-calculation-ingredients">
                          <strong>Ingredients for remaining whole batches</strong>
                          <ul>
                            {live.remainingIngredients.map((ingredient, index) => (
                              <li key={`${ingredient.name}-${index}`}>
                                <span>{ingredient.name}</span>
                                <strong>{formatQuantity(ingredient.wholeBatchRequired)} {ingredient.unit}</strong>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </details>
  );
}
