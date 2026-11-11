import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  facilitiesTable,
  facilityMembersTable,
  pool,
  productionRunsTable,
  runCommandReceiptsTable,
  runCreateReceiptsTable,
  runEventsTable,
  runOutboxTable,
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
  assert.equal(upgradedLegacyRun.name, "Legacy V2 run label");
  assert.equal(upgradedLegacyRun.createdBy, "legacy-user");
  const upgradedLegacyContract = toContractRun(upgradedLegacyRun);
  assert.equal(upgradedLegacyContract.setupSnapshot.label, "Legacy V2 run label");
  assert.equal(
    upgradedLegacyContract.setupSnapshot.targetCases,
    1,
    "legacy V2 runs use the smallest valid target because the old schema stored no count",
  );

  const legacyLifecycleIds = [
    "20000000-0000-4000-8000-000000000002",
    "20000000-0000-4000-8000-000000000003",
    "20000000-0000-4000-8000-000000000004",
  ];
  const legacyLifecycleRows = await db
    .select()
    .from(productionRunsTable)
    .where(inArray(productionRunsTable.id, legacyLifecycleIds));
  const legacyLifecycleRuns = new Map(
    legacyLifecycleRows.map((row) => [row.id, row]),
  );
  const expectedLegacyRuns = [
    {
      id: legacyLifecycleIds[0],
      name: "Legacy running run",
      createdBy: "legacy-running-user",
      status: "running",
      revision: 7,
      createdAt: "2024-02-01T08:00:00.000Z",
      updatedAt: "2024-02-02T08:15:00.000Z",
      startedAt: "2024-02-01T08:10:00.000Z",
      pausedAt: null,
      resumedAt: "2024-02-01T09:00:00.000Z",
      completedAt: null,
      pauseIntervals: [
        {
          startedAt: "2024-02-01T08:30:00.000Z",
          endedAt: "2024-02-01T09:00:00.000Z",
        },
      ],
    },
    {
      id: legacyLifecycleIds[1],
      name: "Legacy paused run",
      createdBy: "legacy-paused-user",
      status: "paused",
      revision: 8,
      createdAt: "2024-03-01T09:00:00.000Z",
      updatedAt: "2024-03-02T12:00:00.000Z",
      startedAt: "2024-03-01T09:10:00.000Z",
      pausedAt: "2024-03-02T12:00:00.000Z",
      resumedAt: "2024-03-02T11:00:00.000Z",
      completedAt: null,
      pauseIntervals: [
        {
          startedAt: "2024-03-01T10:30:00.000Z",
          endedAt: "2024-03-01T11:00:00.000Z",
        },
        {
          startedAt: "2024-03-02T12:00:00.000Z",
          endedAt: null,
        },
      ],
    },
    {
      id: legacyLifecycleIds[2],
      name: "Legacy completed run",
      createdBy: "legacy-completed-user",
      status: "completed",
      revision: 10,
      createdAt: "2024-04-01T07:00:00.000Z",
      updatedAt: "2024-04-02T14:00:00.000Z",
      startedAt: "2024-04-01T07:10:00.000Z",
      pausedAt: null,
      resumedAt: "2024-04-02T11:30:00.000Z",
      completedAt: "2024-04-02T14:00:00.000Z",
      pauseIntervals: [
        {
          startedAt: "2024-04-01T08:00:00.000Z",
          endedAt: "2024-04-01T08:30:00.000Z",
        },
        {
          startedAt: "2024-04-02T10:00:00.000Z",
          endedAt: "2024-04-02T11:30:00.000Z",
        },
      ],
    },
  ] as const;
  for (const expected of expectedLegacyRuns) {
    const row = legacyLifecycleRuns.get(expected.id);
    assert.ok(row, `legacy ${expected.status} run should remain present`);
    assert.equal(row.name, expected.name);
    assert.equal(row.createdBy, expected.createdBy);
    const run = toContractRun(row);
    assert.equal(run.status, expected.status);
    assert.equal(run.revision, expected.revision);
    assert.equal(run.setupSnapshot.targetCases, 1);
    assert.deepEqual(
      {
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
        startedAt: run.startedAt?.toISOString() ?? null,
        pausedAt: run.pausedAt?.toISOString() ?? null,
        resumedAt: run.resumedAt?.toISOString() ?? null,
        completedAt: run.completedAt?.toISOString() ?? null,
      },
      {
        createdAt: expected.createdAt,
        updatedAt: expected.updatedAt,
        startedAt: expected.startedAt,
        pausedAt: expected.pausedAt,
        resumedAt: expected.resumedAt,
        completedAt: expected.completedAt,
      },
      `${expected.status} run timestamps should remain unchanged`,
    );
    assert.deepEqual(run.pauseIntervals, expected.pauseIntervals);
  }

  const [legacyRunEvent] = await db
    .select()
    .from(runEventsTable)
    .where(eq(runEventsTable.id, "30000000-0000-4000-8000-000000000001"))
    .limit(1);
  assert.ok(legacyRunEvent, "the pre-upgrade run event should remain present");
  assert.deepEqual(
    {
      id: legacyRunEvent.id,
      facilityId: legacyRunEvent.facilityId,
      runId: legacyRunEvent.runId,
      actorUserId: legacyRunEvent.actorUserId,
      action: legacyRunEvent.action,
      fromStatus: legacyRunEvent.fromStatus,
      toStatus: legacyRunEvent.toStatus,
      revision: legacyRunEvent.revision,
      occurredAt: legacyRunEvent.occurredAt.toISOString(),
    },
    {
      id: "30000000-0000-4000-8000-000000000001",
      facilityId: "10000000-0000-4000-8000-000000000001",
      runId: legacyLifecycleIds[0],
      actorUserId: "legacy-operator",
      action: "start",
      fromStatus: "draft",
      toStatus: "running",
      revision: 7,
      occurredAt: "2024-02-01T08:10:00.000Z",
    },
    "the pre-upgrade run audit fields should remain unchanged",
  );

  const [legacyCommandReceipt] = await db
    .select()
    .from(runCommandReceiptsTable)
    .where(
      eq(
        runCommandReceiptsTable.id,
        "40000000-0000-4000-8000-000000000001",
      ),
    )
    .limit(1);
  assert.ok(
    legacyCommandReceipt,
    "the pre-upgrade command retry receipt should remain present",
  );
  assert.deepEqual(
    {
      id: legacyCommandReceipt.id,
      facilityId: legacyCommandReceipt.facilityId,
      runId: legacyCommandReceipt.runId,
      actorUserId: legacyCommandReceipt.actorUserId,
      idempotencyKey: legacyCommandReceipt.idempotencyKey,
      requestHash: legacyCommandReceipt.requestHash,
      result: legacyCommandReceipt.result,
      createdAt: legacyCommandReceipt.createdAt.toISOString(),
    },
    {
      id: "40000000-0000-4000-8000-000000000001",
      facilityId: "10000000-0000-4000-8000-000000000001",
      runId: legacyLifecycleIds[0],
      actorUserId: "legacy-operator",
      idempotencyKey: "legacy-start-command",
      requestHash: "sha256:legacy-request-hash",
      result: { outcome: "accepted", revision: 7, status: "running" },
      createdAt: "2024-02-01T08:10:01.000Z",
    },
    "the pre-upgrade command receipt fields should remain unchanged",
  );

  const [legacyCreateReceipt] = await db
    .select()
    .from(runCreateReceiptsTable)
    .where(
      eq(runCreateReceiptsTable.id, "70000000-0000-4000-8000-000000000001"),
    )
    .limit(1);
  assert.ok(
    legacyCreateReceipt,
    "the pre-upgrade run-creation retry receipt should remain present",
  );
  assert.deepEqual(
    {
      facilityId: legacyCreateReceipt.facilityId,
      actorUserId: legacyCreateReceipt.actorUserId,
      requestId: legacyCreateReceipt.requestId,
      requestHash: legacyCreateReceipt.requestHash,
      runId: legacyCreateReceipt.runId,
      createdAt: legacyCreateReceipt.createdAt.toISOString(),
    },
    {
      facilityId: "10000000-0000-4000-8000-000000000001",
      actorUserId: "legacy-owner",
      requestId: "60000000-0000-4000-8000-000000000001",
      requestHash:
        "bdb6e37d45b375fa4d9a9215a7352b1fd4b60d4ac35824f0c4db2833f1797355",
      runId: "20000000-0000-4000-8000-000000000001",
      createdAt: "2024-01-31T07:00:00.000Z",
    },
    "the pre-upgrade run-creation receipt fields should remain unchanged",
  );
  const replayedLegacyCreate = await createPlannedRun({
    facilityId: legacyCreateReceipt.facilityId,
    actorUserId: legacyCreateReceipt.actorUserId,
    requestId: legacyCreateReceipt.requestId,
    setupSnapshot: { label: "Legacy V2 run label", targetCases: 1 },
  });
  assert.equal(replayedLegacyCreate.outcome, "created");
  assert.equal(replayedLegacyCreate.replayed, true);
  assert.equal(
    replayedLegacyCreate.run.id,
    "20000000-0000-4000-8000-000000000001",
    "an identical create retry should resolve to the original run after upgrade",
  );

  const [legacyOutboxEvent] = await db
    .select()
    .from(runOutboxTable)
    .where(eq(runOutboxTable.id, "50000000-0000-4000-8000-000000000001"))
    .limit(1);
  assert.ok(
    legacyOutboxEvent,
    "the pre-upgrade queued notification should remain present",
  );
  assert.deepEqual(
    {
      id: legacyOutboxEvent.id,
      facilityId: legacyOutboxEvent.facilityId,
      runId: legacyOutboxEvent.runId,
      revision: legacyOutboxEvent.revision,
      event: legacyOutboxEvent.event,
      createdAt: legacyOutboxEvent.createdAt.toISOString(),
      deliveredAt: legacyOutboxEvent.deliveredAt?.toISOString() ?? null,
      attempts: legacyOutboxEvent.attempts,
    },
    {
      id: "50000000-0000-4000-8000-000000000001",
      facilityId: "10000000-0000-4000-8000-000000000001",
      runId: legacyLifecycleIds[0],
      revision: 7,
      event: {
        type: "run.updated",
        runId: legacyLifecycleIds[0],
        revision: 7,
        status: "running",
      },
      createdAt: "2024-02-01T08:10:02.000Z",
      deliveredAt: null,
      attempts: 2,
    },
    "the pre-upgrade queued notification fields should remain unchanged",
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

test("run command rolls back all history when the receipt write fails", async () => {
  const [facility] = await db
    .insert(facilitiesTable)
    .values({ name: "Run command rollback facility" })
    .returning();
  const actorUserId = `rollback-test-user-${randomUUID()}`;
  const created = await createPlannedRun({
    facilityId: facility.id,
    actorUserId,
    requestId: randomUUID(),
    setupSnapshot: { label: "Rollback test run", targetCases: 12 },
  });
  assert.equal(created.outcome, "created");
  const runId = created.run.id;
  const commandId = "rollback-after-outbox";

  await pool.query(`
    CREATE FUNCTION fail_test_run_command_receipt() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.idempotency_key = '${commandId}' THEN
        RAISE EXCEPTION 'intentional failure after run event and outbox writes';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER fail_test_run_command_receipt
      BEFORE INSERT ON run_command_receipts
      FOR EACH ROW EXECUTE FUNCTION fail_test_run_command_receipt();
  `);

  try {
    const [runBefore] = await db
      .select()
      .from(productionRunsTable)
      .where(eq(productionRunsTable.id, runId))
      .limit(1);
    const eventsBefore = await db
      .select()
      .from(runEventsTable)
      .where(eq(runEventsTable.runId, runId));
    const receiptsBefore = await db
      .select()
      .from(runCommandReceiptsTable)
      .where(eq(runCommandReceiptsTable.runId, runId));
    const outboxBefore = await db
      .select()
      .from(runOutboxTable)
      .where(eq(runOutboxTable.runId, runId));

    assert.equal(runBefore.status, "planned");
    assert.equal(runBefore.revision, 0);
    assert.deepEqual(eventsBefore, []);
    assert.deepEqual(receiptsBefore, []);
    assert.deepEqual(outboxBefore, []);

    await assert.rejects(
      executeRunCommand({
        facilityId: facility.id,
        actorUserId,
        runId,
        command: {
          commandId,
          commandType: "start",
          expectedRevision: 0,
        },
      }),
      (error: unknown) =>
        error instanceof Error &&
        error.cause instanceof Error &&
        error.cause.message.includes(
          "intentional failure after run event and outbox writes",
        ),
    );

    const [runAfter] = await db
      .select()
      .from(productionRunsTable)
      .where(eq(productionRunsTable.id, runId))
      .limit(1);
    const eventsAfter = await db
      .select()
      .from(runEventsTable)
      .where(eq(runEventsTable.runId, runId));
    const receiptsAfter = await db
      .select()
      .from(runCommandReceiptsTable)
      .where(eq(runCommandReceiptsTable.runId, runId));
    const outboxAfter = await db
      .select()
      .from(runOutboxTable)
      .where(eq(runOutboxTable.runId, runId));

    assert.deepEqual(runAfter, runBefore, "the run update should roll back");
    assert.deepEqual(eventsAfter, eventsBefore, "the event should roll back");
    assert.deepEqual(
      receiptsAfter,
      receiptsBefore,
      "the command receipt should not be partially recorded",
    );
    assert.deepEqual(outboxAfter, outboxBefore, "the outbox write should roll back");
  } finally {
    await pool.query(`
      DROP TRIGGER IF EXISTS fail_test_run_command_receipt ON run_command_receipts;
      DROP FUNCTION IF EXISTS fail_test_run_command_receipt();
    `);
  }
});
