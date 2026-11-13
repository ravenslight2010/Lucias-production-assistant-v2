import { createHash } from "node:crypto";
import { and, count, desc, eq } from "drizzle-orm";
import {
  db,
  productionRunsTable,
  runQualityMeasurementsTable,
} from "@workspace/db";
import type {
  RunQualityChecks,
  RunQualityMeasurementsInput,
} from "@workspace/api-zod";
import { HttpError } from "./http-error";
import { buildRunQualityTargets } from "./run-quality-checks";

type QualityQuery = Pick<typeof db, "select">;
const round = (value: number) => Number(value.toFixed(6));
const requestHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function measurementResponse(row: typeof runQualityMeasurementsTable.$inferSelect) {
  return {
    id: row.id,
    checkId: row.checkId,
    observedOz: row.observedOz,
    minimumOz: row.minimumOz,
    maximumOz: row.maximumOz,
    passed: row.passed,
    recordedAt: row.createdAt,
  };
}

async function responseForRun(
  query: QualityQuery,
  input: { facilityId: string; runId: string; productSnapshot: unknown },
): Promise<RunQualityChecks> {
  const stored = await query
    .select()
    .from(runQualityMeasurementsTable)
    .where(and(
      eq(runQualityMeasurementsTable.facilityId, input.facilityId),
      eq(runQualityMeasurementsTable.runId, input.runId),
    ))
    .orderBy(desc(runQualityMeasurementsTable.createdAt))
    .limit(1000);
  const targets = buildRunQualityTargets(input.productSnapshot);
  return {
    runId: input.runId,
    checks: targets.checks,
    measurements: stored.map(measurementResponse),
    unavailableReason: targets.unavailableReason,
  };
}

export async function getRunQualityChecks(input: {
  facilityId: string;
  runId: string;
}): Promise<RunQualityChecks> {
  const [run] = await db
    .select({
      id: productionRunsTable.id,
      productSnapshot: productionRunsTable.productSnapshot,
    })
    .from(productionRunsTable)
    .where(and(
      eq(productionRunsTable.id, input.runId),
      eq(productionRunsTable.facilityId, input.facilityId),
    ))
    .limit(1);
  if (!run) throw new HttpError(404, "Run not found.");
  return responseForRun(db, {
    facilityId: input.facilityId,
    runId: input.runId,
    productSnapshot: run.productSnapshot,
  });
}

export async function recordRunQualityMeasurements(input: {
  facilityId: string;
  actorUserId: string;
  runId: string;
  update: RunQualityMeasurementsInput;
}): Promise<RunQualityChecks> {
  const normalizedItems = [...input.update.items]
    .map((item) => ({ checkId: item.checkId.trim(), observedOz: round(item.observedOz) }))
    .sort((a, b) => a.checkId.localeCompare(b.checkId));
  if (
    normalizedItems.some((item) => !item.checkId || item.observedOz < 0 || item.observedOz > 10000) ||
    new Set(normalizedItems.map((item) => item.checkId)).size !== normalizedItems.length
  ) {
    throw new HttpError(400, "Enter one valid ounce measurement for each quality check.");
  }
  const hash = requestHash({
    facilityId: input.facilityId,
    actorUserId: input.actorUserId,
    runId: input.runId,
    items: normalizedItems,
  });

  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({
        id: productionRunsTable.id,
        productSnapshot: productionRunsTable.productSnapshot,
      })
      .from(productionRunsTable)
      .where(and(
        eq(productionRunsTable.id, input.runId),
        eq(productionRunsTable.facilityId, input.facilityId),
      ))
      .for("update")
      .limit(1);
    if (!run) throw new HttpError(404, "Run not found.");

    const targetSet = buildRunQualityTargets(run.productSnapshot);
    const targets = new Map(targetSet.checks.map((check) => [check.id, check]));
    const submittedTargets = normalizedItems.map((item) => targets.get(item.checkId));
    if (submittedTargets.some((target) => !target || target.status !== "ready")) {
      throw new HttpError(400, "Select only quality checks with confirmed weight targets.");
    }

    const existing = await tx
      .select()
      .from(runQualityMeasurementsTable)
      .where(and(
        eq(runQualityMeasurementsTable.facilityId, input.facilityId),
        eq(runQualityMeasurementsTable.runId, input.runId),
        eq(runQualityMeasurementsTable.commandId, input.update.commandId),
      ))
      .limit(201);
    if (existing.length) {
      if (
        existing.length !== normalizedItems.length ||
        existing.some((row) => row.requestHash !== hash)
      ) {
        throw new HttpError(409, "This quality-check request was already used with different measurements.");
      }
      return responseForRun(tx, {
        facilityId: input.facilityId,
        runId: input.runId,
        productSnapshot: run.productSnapshot,
      });
    }

    const [currentCount] = await tx
      .select({ total: count() })
      .from(runQualityMeasurementsTable)
      .where(and(
        eq(runQualityMeasurementsTable.facilityId, input.facilityId),
        eq(runQualityMeasurementsTable.runId, input.runId),
      ));
    if ((currentCount?.total ?? 0) + normalizedItems.length > 1000) {
      throw new HttpError(409, "This run has reached its quality-measurement history limit.");
    }

    const values = normalizedItems.map((item, index) => {
      const target = submittedTargets[index]!;
      const observedOz = item.observedOz;
      return {
        facilityId: input.facilityId,
        runId: input.runId,
        commandId: input.update.commandId,
        requestHash: hash,
        checkId: target.id,
        checkType: target.checkType,
        checkLabel: target.label,
        source: target.source,
        targetOz: target.targetOz,
        minimumOz: target.minimumOz!,
        maximumOz: target.maximumOz!,
        toleranceOz: target.toleranceOz,
        observedOz,
        passed: observedOz >= target.minimumOz! && observedOz <= target.maximumOz!,
        actorUserId: input.actorUserId,
      };
    });
    await tx.insert(runQualityMeasurementsTable).values(values);

    return responseForRun(tx, {
      facilityId: input.facilityId,
      runId: input.runId,
      productSnapshot: run.productSnapshot,
    });
  });
}
