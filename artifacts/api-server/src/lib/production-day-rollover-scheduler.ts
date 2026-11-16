export interface ProductionDayRolloverResult {
  productionDay: string;
  facilityCount: number;
  closedRunCount: number;
}

interface ProductionDayRolloverSchedulerOptions {
  getProductionDay: () => Promise<string>;
  getFacilityIds: () => Promise<string[]>;
  closeFacilityRuns: (facilityId: string) => Promise<number>;
  onComplete?: (result: ProductionDayRolloverResult) => void;
  onError?: (error: unknown, productionDay: string | null) => void;
  retryDelayMs?: number;
  now?: () => number;
}

const DEFAULT_RETRY_DELAY_MS = 5 * 60 * 1000;

export function createProductionDayRolloverScheduler(
  options: ProductionDayRolloverSchedulerOptions,
) {
  const now = options.now ?? Date.now;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  let completedDay: string | null = null;
  let retryAfter = 0;

  return async function runProductionDayRolloverSweep(): Promise<void> {
    const attemptStartedAt = now();
    if (attemptStartedAt < retryAfter) return;

    let productionDay: string | null = null;
    try {
      productionDay = await options.getProductionDay();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(productionDay)) {
        throw new Error("The database returned an invalid production day.");
      }
      if (productionDay === completedDay) return;

      const facilityIds = await options.getFacilityIds();
      let closedRunCount = 0;
      for (const facilityId of facilityIds) {
        closedRunCount += await options.closeFacilityRuns(facilityId);
      }

      completedDay = productionDay;
      retryAfter = 0;
      options.onComplete?.({
        productionDay,
        facilityCount: facilityIds.length,
        closedRunCount,
      });
    } catch (error) {
      retryAfter = now() + retryDelayMs;
      options.onError?.(error, productionDay);
    }
  };
}
