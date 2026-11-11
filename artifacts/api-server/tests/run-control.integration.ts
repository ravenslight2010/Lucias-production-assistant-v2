import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  db,
  facilitiesTable,
  facilityMembersTable,
  pool,
  productionRunsTable,
} from "@workspace/db";
import { createPlannedRun } from "../src/lib/run-create-service";
import { executeRunCommand } from "../src/lib/run-command-service";
import { toContractRun } from "../src/lib/run-contract";
import {
  issueV2Session,
  verifyV2SessionToken,
} from "../src/lib/v2-session";
import {
  assertRunPermission,
  getFacilityMembership,
} from "../src/lib/run-permissions";

after(async () => {
  await pool.end();
});

test("independent signed-in sessions share canonical revisions and safe retries", async () => {
  const [facility] = await db
    .insert(facilitiesTable)
    .values({ name: "Synthetic integration facility" })
    .returning();
  const actorA = `test-user-a-${randomUUID()}`;
  const actorB = `test-user-b-${randomUUID()}`;
  await db.insert(facilityMembersTable).values([
    { facilityId: facility.id, userId: actorA, role: "owner" },
    { facilityId: facility.id, userId: actorB, role: "operator" },
  ]);

  const clerkSessionA = `clerk-session-a-${randomUUID()}`;
  const clerkSessionB = `clerk-session-b-${randomUUID()}`;
  const sessionA = issueV2Session(actorA, clerkSessionA);
  const sessionB = issueV2Session(actorB, clerkSessionB);
  assert.notEqual(sessionA.token, sessionB.token);
  assert.equal(
    verifyV2SessionToken(sessionA.token, actorA, `${clerkSessionA}-other`),
    null,
    "a session must not authenticate under a different Clerk session",
  );
  const verifiedA = verifyV2SessionToken(sessionA.token, actorA, clerkSessionA);
  const verifiedB = verifyV2SessionToken(sessionB.token, actorB, clerkSessionB);
  assert.equal(verifiedA?.actorId, actorA);
  assert.equal(verifiedB?.actorId, actorB);
  assert.equal(
    verifiedB && "role" in verifiedB,
    false,
    "signed-in session claims must not cache a facility role",
  );

  const ownerMembership = await getFacilityMembership(actorA);
  assert.ok(ownerMembership);
  for (const action of ["create", "start", "pause", "resume", "complete"] as const) {
    assert.doesNotThrow(() => assertRunPermission(ownerMembership.role, action));
  }

  const operatorMembership = await getFacilityMembership(actorB);
  assert.ok(operatorMembership);
  assert.equal(operatorMembership?.role, "operator");
  assert.throws(
    () => assertRunPermission(operatorMembership.role, "create"),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "statusCode" in error &&
          error.statusCode === 403,
      ),
    "operators cannot create runs",
  );
  for (const action of ["start", "pause", "resume"] as const) {
    assert.doesNotThrow(() =>
      assertRunPermission(operatorMembership.role, action),
    );
  }
  assert.throws(
    () => assertRunPermission(operatorMembership.role, "complete"),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "statusCode" in error &&
          error.statusCode === 403,
      ),
    "operators cannot complete runs",
  );

  await db
    .update(facilityMembersTable)
    .set({ role: "manager" })
    .where(eq(facilityMembersTable.userId, actorB));
  const promotedMembership = await getFacilityMembership(actorB);
  assert.ok(promotedMembership);
  assert.equal(promotedMembership?.role, "manager");
  assert.equal(
    verifyV2SessionToken(sessionB.token, actorB, clerkSessionB)?.actorId,
    actorB,
  );
  assert.doesNotThrow(() =>
    assertRunPermission(promotedMembership.role, "create"),
  );
  assert.doesNotThrow(() =>
    assertRunPermission(promotedMembership.role, "complete"),
  );

  await db
    .update(facilityMembersTable)
    .set({ role: "operator" })
    .where(eq(facilityMembersTable.userId, actorB));
  const demotedMembership = await getFacilityMembership(actorB);
  assert.ok(demotedMembership);
  assert.equal(demotedMembership?.role, "operator");
  assert.throws(
    () => assertRunPermission(demotedMembership.role, "complete"),
    (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "statusCode" in error &&
          error.statusCode === 403,
      ),
    "the same session loses manager permissions after the database role changes",
  );

  const [upgradedLegacyRun] = await db
    .select()
    .from(productionRunsTable)
    .where(eq(productionRunsTable.id, "20000000-0000-4000-8000-000000000001"))
    .limit(1);
  assert.ok(upgradedLegacyRun, "the pre-upgrade V2 run should remain present");
  const upgradedLegacyContract = toContractRun(upgradedLegacyRun);
  assert.equal(upgradedLegacyContract.setupSnapshot.label, "Legacy V2 run label");
  assert.equal(
    upgradedLegacyContract.setupSnapshot.targetCases,
    1,
    "legacy V2 runs use the smallest valid target because the old schema stored no count",
  );
  const v1Fixture = await pool.query(
    "SELECT id, label, target_cases FROM v1_archive.v1_runs WHERE id = $1",
    ["v1-fixture"],
  );
  assert.deepEqual(v1Fixture.rows, [
    { id: "v1-fixture", label: "V1 data stays separate", target_cases: 37 },
  ]);
  const v2Rows = await db.select().from(productionRunsTable);
  assert.equal(
    v2Rows.some((run) => run.name === "V1 data stays separate"),
    false,
    "V1 rows must not be included in V2 production runs",
  );

  const [legacyDraft] = await db
    .insert(productionRunsTable)
    .values({
      facilityId: facility.id,
      name: "Legacy V2 draft",
      status: "draft",
      revision: 1,
      createdBy: actorA,
    })
    .returning();
  const normalizedLegacy = toContractRun(legacyDraft);
  assert.equal(normalizedLegacy.status, "planned");
  assert.equal(normalizedLegacy.revision, 1);

  const requestId = randomUUID();
  const created = await createPlannedRun({
    facilityId: facility.id,
    actorUserId: actorA,
    requestId,
    setupSnapshot: { label: "Synthetic run", targetCases: 24 },
  });
  assert.equal(created.outcome, "created");
  assert.equal(created.replayed, false);
  assert.equal(created.run.status, "planned");
  assert.equal(created.run.revision, 0);
  assert.deepEqual(created.run.setupSnapshot, {
    label: "Synthetic run",
    targetCases: 24,
  });

  const replayedCreate = await createPlannedRun({
    facilityId: facility.id,
    actorUserId: actorA,
    requestId,
    setupSnapshot: { label: "Synthetic run", targetCases: 24 },
  });
  assert.equal(replayedCreate.replayed, true);
  assert.equal(replayedCreate.run.id, created.run.id);
  await assert.rejects(
    createPlannedRun({
      facilityId: facility.id,
      actorUserId: actorA,
      requestId,
      setupSnapshot: { label: "Changed details", targetCases: 24 },
    }),
    (error: unknown) => Boolean(error && typeof error === "object" && "statusCode" in error && error.statusCode === 409),
  );

  const concurrentRequestId = randomUUID();
  const concurrentCreates = await Promise.all([
    createPlannedRun({
      facilityId: facility.id,
      actorUserId: actorA,
      requestId: concurrentRequestId,
      setupSnapshot: { label: "Concurrent synthetic run", targetCases: 2 },
    }),
    createPlannedRun({
      facilityId: facility.id,
      actorUserId: actorA,
      requestId: concurrentRequestId,
      setupSnapshot: { label: "Concurrent synthetic run", targetCases: 2 },
    }),
  ]);
  assert.equal(concurrentCreates[0].run.id, concurrentCreates[1].run.id);
  assert.equal(concurrentCreates.filter((result) => result.replayed).length, 1);

  const startCommand = {
    commandId: `start-${randomUUID()}`,
    commandType: "start" as const,
    expectedRevision: 0,
  };
  const started = await executeRunCommand({
    facilityId: facility.id,
    actorUserId: actorA,
    runId: created.run.id,
    command: startCommand,
  });
  assert.equal(started.outcome, "accepted");
  if (started.outcome !== "accepted") return;
  assert.equal(started.run.revision, 1);

  // Simulate a client reconnecting after the server committed but before the
  // response arrived; the exact command ID returns an accepted replay.
  const retried = await executeRunCommand({
    facilityId: facility.id,
    actorUserId: actorA,
    runId: created.run.id,
    command: startCommand,
  });
  assert.equal(retried.outcome, "accepted");
  if (retried.outcome !== "accepted") return;
  assert.equal(retried.replayed, true);
  assert.equal(retried.run.revision, 1);

  const reusedCommandId = await executeRunCommand({
    facilityId: facility.id,
    actorUserId: actorA,
    runId: created.run.id,
    command: {
      ...startCommand,
      commandType: "pause",
    },
  });
  assert.equal(reusedCommandId.outcome, "conflict");
  if (reusedCommandId.outcome !== "conflict") return;
  assert.equal(reusedCommandId.currentRun.revision, 1);

  const staleCommand = await executeRunCommand({
    facilityId: facility.id,
    actorUserId: actorB,
    runId: created.run.id,
    command: {
      commandId: `pause-stale-${randomUUID()}`,
      commandType: "pause",
      expectedRevision: 0,
    },
  });
  assert.equal(staleCommand.outcome, "conflict");
  if (staleCommand.outcome !== "conflict") return;
  assert.equal(staleCommand.currentRun.revision, 1);
  assert.equal(staleCommand.currentRun.status, "running");

  const [reconnectedRow] = await db
    .select()
    .from(productionRunsTable)
    .where(
      and(
        eq(productionRunsTable.id, created.run.id),
        eq(productionRunsTable.facilityId, facility.id),
      ),
    )
    .limit(1);
  const reconnectedRun = toContractRun(reconnectedRow);
  assert.equal(reconnectedRun.revision, 1);
  assert.equal(reconnectedRun.status, "running");

  const paused = await executeRunCommand({
    facilityId: facility.id,
    actorUserId: actorB,
    runId: created.run.id,
    command: {
      commandId: `pause-${randomUUID()}`,
      commandType: "pause",
      expectedRevision: reconnectedRun.revision,
    },
  });
  assert.equal(paused.outcome, "accepted");
  if (paused.outcome !== "accepted") return;
  assert.equal(paused.run.revision, 2);
  assert.equal(paused.run.status, "paused");
  assert.equal(paused.run.pauseIntervals.length, 1);
  assert.equal(paused.run.pauseIntervals[0].endedAt, null);
});
