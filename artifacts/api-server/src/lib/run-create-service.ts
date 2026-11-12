import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  facilityProductProfilesTable,
  productionRunsTable,
  runCreateReceiptsTable,
} from "@workspace/db";
import { HttpError } from "./http-error";
import { toContractRun } from "./run-contract";
import { lockProfileNames } from "./profile-names";
import { loadNameResolution, resolutionForProfile } from "./name-resolution";
import { buildRunRequirements } from "./run-requirements";
import type { RunPlanningReview } from "@workspace/api-zod";

export interface RunSetupSnapshot {
  label: string;
  targetCases: number;
  productProfileId?: string | null;
  planning?: RunPlanningReview;
}

function setupHash(setupSnapshot: RunSetupSnapshot) {
  return createHash("sha256")
    .update(JSON.stringify({
      label: setupSnapshot.label.trim(),
      targetCases: setupSnapshot.targetCases,
      productProfileId: setupSnapshot.productProfileId ?? null,
      ...(setupSnapshot.planning ? { planning: setupSnapshot.planning } : {}),
    }))
    .digest("hex");
}

async function getReplay(input: {
  facilityId: string;
  actorUserId: string;
  requestId: string;
  requestHash: string;
}) {
  const [receipt] = await db
    .select()
    .from(runCreateReceiptsTable)
    .where(
      and(
        eq(runCreateReceiptsTable.facilityId, input.facilityId),
        eq(runCreateReceiptsTable.actorUserId, input.actorUserId),
        eq(runCreateReceiptsTable.requestId, input.requestId),
      ),
    )
    .limit(1);
  if (!receipt) return null;
  if (receipt.requestHash !== input.requestHash) {
    throw new HttpError(409, "This request ID was already used for different run details.");
  }
  const [run] = await db
    .select()
    .from(productionRunsTable)
    .where(
      and(
        eq(productionRunsTable.id, receipt.runId),
        eq(productionRunsTable.facilityId, input.facilityId),
      ),
    )
    .limit(1);
  if (!run) throw new HttpError(409, "The original run for this request is unavailable.");
  return { outcome: "created" as const, replayed: true, run: toContractRun(run) };
}

export async function createPlannedRun(input: {
  facilityId: string;
  actorUserId: string;
  requestId: string;
  setupSnapshot: RunSetupSnapshot;
}) {
  const requestHash = setupHash(input.setupSnapshot);
  const replayInput = { ...input, requestHash };
  const replay = await getReplay(replayInput);
  if (replay) return replay;

  try {
    return await db.transaction(async (tx) => {
      await lockProfileNames(tx, input.facilityId);
      const profileId = input.setupSnapshot.productProfileId ?? null;
      const [productProfile] = profileId
        ? await tx.select().from(facilityProductProfilesTable).where(and(
            eq(facilityProductProfilesTable.id, profileId),
            eq(facilityProductProfilesTable.facilityId, input.facilityId),
          )).limit(1)
        : [];
      if (profileId && !productProfile) {
        throw new HttpError(404, "The selected product profile is no longer available.");
      }
      if (productProfile?.mergedIntoId) throw new HttpError(409, "This product profile was merged. Refresh and review the surviving product before creating a run.");
      const resolution = productProfile ? await loadNameResolution(tx, input.facilityId) : undefined;
      const nameResolution = productProfile && resolution ? resolutionForProfile(productProfile, resolution) : undefined;
      const review = input.setupSnapshot.planning;
      if (review && (!productProfile || !resolution)) throw new HttpError(400, "A requirements plan needs a selected product profile.");
      if (review && productProfile && resolution &&
        (review.expectedProfileRevision !== productProfile.revision || review.expectedNameRevision !== resolution.revision)) {
        throw new HttpError(409, "The product or remembered names changed after requirements were reviewed. Refresh and review the plan before creating the run.");
      }
      const runRequirements = review && productProfile && resolution
        ? buildRunRequirements({ ...productProfile, nameResolution: resolution }, input.setupSnapshot.targetCases, review.options)
        : undefined;
      const productSnapshot = productProfile
        ? {
            id: productProfile.id,
            brand: productProfile.brand,
            flavor: productProfile.flavor,
            revision: productProfile.revision,
            productData: productProfile.productData,
            createdAt: productProfile.createdAt,
            updatedAt: productProfile.updatedAt,
            mergedIntoId: productProfile.mergedIntoId,
            ...(nameResolution ? { nameResolution } : {}),
            ...(runRequirements ? { runRequirements } : {}),
          }
        : null;
      const [run] = await tx
        .insert(productionRunsTable)
        .values({
          facilityId: input.facilityId,
          name: input.setupSnapshot.label.trim(),
          productProfileId: profileId,
          productSnapshot,
          targetCases: input.setupSnapshot.targetCases,
          status: "planned",
          revision: 0,
          createdBy: input.actorUserId,
          pauseIntervals: [],
        })
        .returning();

      await tx.insert(runCreateReceiptsTable).values({
        facilityId: input.facilityId,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        requestHash,
        runId: run.id,
      });
      return { outcome: "created" as const, replayed: false, run: toContractRun(run) };
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "23505"
    ) {
      const concurrentReplay = await getReplay(replayInput);
      if (concurrentReplay) return concurrentReplay;
    }
    throw error;
  }
}
