import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  facilitiesTable,
  facilityImportBatchesTable,
  facilityProductProfilesTable,
  pool,
  productionRunsTable,
} from "@workspace/db";
import { HttpError } from "../src/lib/http-error";
import { importSchedule } from "../src/lib/schedule-import-service";

after(async () => {
  await pool.end();
});

async function createScenario() {
  const suffix = randomUUID();
  const [facility] = await db
    .insert(facilitiesTable)
    .values({ name: `Schedule import safeguard ${suffix}` })
    .returning({ id: facilitiesTable.id });
  assert.ok(facility);

  const [firstProfile, secondProfile] = await db
    .insert(facilityProductProfilesTable)
    .values([
      {
        facilityId: facility.id,
        brand: `Schedule QA ${suffix}`,
        flavor: "Cheese",
        normalizedKey: `${suffix}:cheese`,
        productData: { source: "schedule import test" },
        createdBy: "schedule-import-test",
      },
      {
        facilityId: facility.id,
        brand: `Schedule QA ${suffix}`,
        flavor: "Pepperoni",
        normalizedKey: `${suffix}:pepperoni`,
        productData: { source: "schedule import test" },
        createdBy: "schedule-import-test",
      },
    ])
    .returning({ id: facilityProductProfilesTable.id });
  assert.ok(firstProfile && secondProfile);

  const sourceHash = createHash("sha256").update(suffix).digest("hex");
  const today = new Date().toISOString().slice(0, 10);
  const input = {
    facilityId: facility.id,
    actorUserId: "schedule-import-test",
    sourceName: `schedule-${suffix}.xlsx`,
    sourceHash,
    importDate: today,
    ignoredPastCount: 0,
    planningByProfile: [{
      productProfileId: firstProfile.id,
      review: {
        expectedProfileRevision: 0,
        expectedNameRevision: 0,
        options: {},
      },
    }],
    runs: [
      {
        date: today,
        brand: `Schedule QA ${suffix}`,
        flavor: "Cheese",
        productProfileId: firstProfile.id,
        casesPlanned: 24,
        notes: "Concurrent-import test",
        source: { sheet: "Weekly schedule", row: 4 },
      },
      {
        date: today,
        brand: `Schedule QA ${suffix}`,
        flavor: "Cheese",
        productProfileId: firstProfile.id,
        casesPlanned: 5,
        notes: "Second run, same reviewed profile",
        source: { sheet: "Weekly schedule", row: 5 },
      },
    ],
  };

  return {
    facilityId: facility.id,
    firstProfileId: firstProfile.id,
    secondProfileId: secondProfile.id,
    input,
  };
}

async function removeScenario(facilityId: string) {
  await db.delete(facilitiesTable).where(eq(facilitiesTable.id, facilityId));
}

test("simultaneous identical schedule imports create one batch and one set of runs", async () => {
  const scenario = await createScenario();
  try {
    const results = await Promise.all([
      importSchedule(scenario.input),
      importSchedule(scenario.input),
    ]);

    assert.equal(results[0].importId, results[1].importId);
    assert.equal(results.filter((result) => !result.replayed).length, 1);
    assert.equal(results.filter((result) => result.replayed).length, 1);
    assert.deepEqual(results.map((result) => result.importedCount), [2, 2]);
    assert.deepEqual(results.map((result) => result.needsReviewRunCount), [2, 2]);

    const runs = await db
      .select({ id: productionRunsTable.id, productSnapshot: productionRunsTable.productSnapshot })
      .from(productionRunsTable)
      .where(eq(productionRunsTable.facilityId, scenario.facilityId));
    const batches = await db
      .select({ id: facilityImportBatchesTable.id })
      .from(facilityImportBatchesTable)
      .where(and(
        eq(facilityImportBatchesTable.facilityId, scenario.facilityId),
        eq(facilityImportBatchesTable.importKind, "schedule"),
      ));
    assert.equal(runs.length, 2);
    const snapshots = runs.map((run) => run.productSnapshot as {
      runRequirements?: { targetCases?: number; status?: string };
    });
    assert.deepEqual(snapshots.map((snapshot) => snapshot.runRequirements?.targetCases).sort((a, b) => (a ?? 0) - (b ?? 0)), [5, 24]);
    assert.ok(snapshots.every((snapshot) => snapshot.runRequirements?.status === "needs_review"));
    assert.equal(batches.length, 1);
  } finally {
    await removeScenario(scenario.facilityId);
  }
});

test("schedule run requirements are mandatory and changed review choices cannot replay", async () => {
  const scenario = await createScenario();
  try {
    await assert.rejects(
      importSchedule({ ...scenario.input, planningByProfile: [] }),
      (error: unknown) => error instanceof HttpError && error.statusCode === 400,
    );
    const first = await importSchedule(scenario.input);
    assert.equal(first.needsReviewRunCount, 2);

    await assert.rejects(
      importSchedule({
        ...scenario.input,
        planningByProfile: scenario.input.planningByProfile.map((item) => ({
          ...item,
          review: { ...item.review, options: { unitsPerCase: 12 } },
        })),
      }),
      (error: unknown) => error instanceof HttpError && error.statusCode === 409,
    );

    const runs = await db
      .select({ productSnapshot: productionRunsTable.productSnapshot })
      .from(productionRunsTable)
      .where(eq(productionRunsTable.facilityId, scenario.facilityId));
    assert.equal(runs.length, 2);
    const snapshot = runs[0].productSnapshot as {
      runRequirements?: { options?: { unitsPerCase?: number } };
    };
    assert.equal(snapshot.runRequirements?.options?.unitsPerCase, undefined);
  } finally {
    await removeScenario(scenario.facilityId);
  }
});

test("a schedule retry with a changed product mapping is rejected without changing saved runs", async () => {
  const scenario = await createScenario();
  try {
    const first = await importSchedule(scenario.input);
    assert.equal(first.replayed, false);

    const changedMapping = {
      ...scenario.input,
      runs: scenario.input.runs.map((run) => ({
        ...run,
        productProfileId: scenario.secondProfileId,
      })),
    };
    await assert.rejects(
      importSchedule(changedMapping),
      (error: unknown) => error instanceof HttpError && error.statusCode === 409,
    );

    const runs = await db
      .select({
        id: productionRunsTable.id,
        productProfileId: productionRunsTable.productProfileId,
        scheduleSource: productionRunsTable.scheduleSource,
      })
      .from(productionRunsTable)
      .where(eq(productionRunsTable.facilityId, scenario.facilityId));
    const batches = await db
      .select({ id: facilityImportBatchesTable.id })
      .from(facilityImportBatchesTable)
      .where(and(
        eq(facilityImportBatchesTable.facilityId, scenario.facilityId),
        eq(facilityImportBatchesTable.importKind, "schedule"),
      ));

    assert.equal(runs.length, 2);
    assert.equal(runs[0].productProfileId, scenario.firstProfileId);
    assert.equal(runs[0].scheduleSource?.importId, first.importId);
    assert.equal(batches.length, 1);
  } finally {
    await removeScenario(scenario.facilityId);
  }
});
