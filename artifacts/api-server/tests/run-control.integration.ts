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
