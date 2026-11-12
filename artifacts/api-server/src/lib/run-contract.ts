import type { ProductionRun } from "@workspace/db";

export function toContractRun(run: ProductionRun) {
  const snapshot = run.productSnapshot;
  // Older immutable snapshots predate the nullable merge marker required by
  // the profile response contract. Normalize the response, not the saved data.
  const productSnapshot = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
    ? { ...snapshot, mergedIntoId: "mergedIntoId" in snapshot ? snapshot.mergedIntoId ?? null : null }
    : snapshot;
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
    productSnapshot,
    pauseIntervals: run.pauseIntervals,
  };
}
