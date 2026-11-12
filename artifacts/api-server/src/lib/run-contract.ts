import type { ProductionRun } from "@workspace/db";

export function toContractRun(run: ProductionRun) {
  return {
    id: run.id,
    status: run.status === "draft" ? "planned" : run.status,
    revision: run.revision,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    scheduledFor: run.scheduledFor,
    scheduleNotes: run.scheduleNotes,
    scheduleSource: run.scheduleSource,
    startedAt: run.startedAt,
    pausedAt: run.pausedAt,
    resumedAt: run.resumedAt,
    completedAt: run.completedAt,
    setupSnapshot: {
      label: run.name,
      targetCases: run.targetCases,
      productProfileId: run.productProfileId,
    },
    productSnapshot: run.productSnapshot,
    pauseIntervals: run.pauseIntervals,
  };
}
