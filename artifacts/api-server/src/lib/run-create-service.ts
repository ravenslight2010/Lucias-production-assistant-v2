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

export interface RunSetupSnapshot {
  label: string;
  targetCases: number;
  productProfileId?: string | null;
}

function setupHash(setupSnapshot: RunSetupSnapshot) {
  return createHash("sha256")
    .update(JSON.stringify({
      label: setupSnapshot.label.trim(),
      targetCases: setupSnapshot.targetCases,
      productProfileId: setupSnapshot.productProfileId ?? null,
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
      const productSnapshot = productProfile
        ? {
            id: productProfile.id,
            brand: productProfile.brand,
            flavor: productProfile.flavor,
            revision: productProfile.revision,
            productData: productProfile.productData,
            createdAt: productProfile.createdAt,
            updatedAt: productProfile.updatedAt,
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
