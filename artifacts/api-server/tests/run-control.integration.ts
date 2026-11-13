import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cookieParser from "cookie-parser";
import {
  db,
  facilitiesTable,
  facilityMembersTable,
  facilityStationLayoutsTable,
  inventoryTransactionsTable,
  pool,
  productionRunsTable,
  runCommandReceiptsTable,
  runCreateReceiptsTable,
  runEventsTable,
  runOutboxTable,
  runStationProgressTable,
} from "@workspace/db";
import { getFacilityInventory } from "../src/lib/run-inventory-service";
import { createPlannedRun } from "../src/lib/run-create-service";
import { executeRunCommand } from "../src/lib/run-command-service";
import {
  getRunStationProgress,
  updateRunStationProgress,
} from "../src/lib/run-station-progress-service";
import { toContractRun } from "../src/lib/run-contract";
import {
  issueV2Session,
  requireV2Session,
  verifyV2SessionToken,
} from "../src/lib/v2-session";
import { HttpError } from "../src/lib/http-error";
import {
  assertRunPermission,
  getFacilityMembership,
} from "../src/lib/run-permissions";
import productionRouter from "../src/routes/production";

after(async () => {
  await pool.end();
});

test("V2 session middleware rejects changed Clerk identities over HTTP", async () => {
  const actorId = `http-session-owner-${randomUUID()}`;
  const clerkSessionId = `http-session-${randomUUID()}`;
  let currentClerkUserId = actorId;
  let currentClerkSessionId = clerkSessionId;
  const v2Session = issueV2Session(actorId, clerkSessionId);
  let protectedRouteReached = false;

  const app = express();
  app.use(express.json(), cookieParser());
  app.use((req, _res, next) => {
    const authHandler = Object.assign(
      () => ({
        userId: currentClerkUserId,
        sessionId: currentClerkSessionId,
        tokenType: "session_token" as const,
      }),
      { [Symbol.for("@clerk/express.auth")]: true },
    );
    (req as Request & { auth: typeof authHandler }).auth = authHandler;
    next();
  });
  app.get("/test-protected", requireV2Session, (_req, res) => {
    protectedRouteReached = true;
    res.sendStatus(204);
  });
  app.use(productionRouter);
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof HttpError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: "Request could not be completed." });
    },
  );

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const send = () =>
    fetch(`${origin}/v2/session`, {
      method: "DELETE",
      headers: {
        cookie: `v2_session=${v2Session.token}`,
        origin,
        "x-csrf-token": v2Session.csrfToken,
      },
    });
  const sendToProtectedRoute = (token: string) =>
    fetch(`${origin}/test-protected`, {
      headers: { cookie: `v2_session=${token}` },
    });

  try {
    const signatureSeparator = v2Session.token.lastIndexOf(".") + 1;
    const changedSignature =
      v2Session.token[signatureSeparator] === "A" ? "B" : "A";
    const alteredSignatureToken =
      v2Session.token.slice(0, signatureSeparator) +
      changedSignature +
      v2Session.token.slice(signatureSeparator + 1);

    protectedRouteReached = false;
    assert.equal(
      (await sendToProtectedRoute(alteredSignatureToken)).status,
      401,
      "a cookie with an altered signature must be rejected",
    );
    assert.equal(
      protectedRouteReached,
      false,
      "the protected route must not run for a cookie with an altered signature",
    );

    const [sessionBody] = v2Session.token.split(".");
    assert.ok(sessionBody);
    const expiredPayload = JSON.parse(
      Buffer.from(sessionBody, "base64url").toString("utf8"),
    ) as { expiresAt: number };
    expiredPayload.expiresAt = Math.floor(Date.now() / 1000) - 1;
    const expiredBody = Buffer.from(
      JSON.stringify(expiredPayload),
    ).toString("base64url");
    const sessionSecret = process.env.SESSION_SECRET;
    assert.ok(sessionSecret, "the integration test requires SESSION_SECRET");
    const expiredSignature = createHmac("sha256", sessionSecret)
      .update(expiredBody)
      .digest("base64url");

    protectedRouteReached = false;
    assert.equal(
      (
        await sendToProtectedRoute(`${expiredBody}.${expiredSignature}`)
      ).status,
      401,
      "an otherwise valid but expired cookie must be rejected",
    );
    assert.equal(
      protectedRouteReached,
      false,
      "the protected route must not run for an expired cookie",
    );

    protectedRouteReached = false;
    assert.equal(
      (await sendToProtectedRoute(v2Session.token)).status,
      204,
      "a valid cookie must reach the protected route",
    );
    assert.equal(
      protectedRouteReached,
      true,
      "the valid session must invoke the protected route",
    );

    currentClerkUserId = `${actorId}-different`;
    assert.equal(
      (await send()).status,
      401,
      "a signed cookie must be rejected for a different Clerk user",
    );

    currentClerkUserId = actorId;
    currentClerkSessionId = `${clerkSessionId}-different`;
    assert.equal(
      (await send()).status,
      401,
      "a signed cookie must be rejected for a different Clerk session",
    );

    currentClerkSessionId = clerkSessionId;
    assert.equal(
      (await send()).status,
      204,
      "the matching Clerk identity must reach the protected route",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("authenticated run creation rejects invalid setup without saving history", async () => {
  const [facility] = await db
    .insert(facilitiesTable)
    .values({ name: "Invalid run setup integration facility" })
    .returning();
  const actorId = `invalid-run-setup-owner-${randomUUID()}`;
  await db
    .insert(facilityMembersTable)
    .values({ facilityId: facility.id, userId: actorId, role: "owner" });

  const clerkSessionId = `invalid-setup-session-${randomUUID()}`;
  const session = issueV2Session(actorId, clerkSessionId);
  const app = express();
  app.use(express.json(), cookieParser());
  app.use((req, _res, next) => {
    const authHandler = Object.assign(
      () => ({
        userId: actorId,
        sessionId: clerkSessionId,
        tokenType: "session_token" as const,
      }),
      { [Symbol.for("@clerk/express.auth")]: true },
    );
    (req as Request & { auth: typeof authHandler }).auth = authHandler;
    next();
  });
  app.use(productionRouter);
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof HttpError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: "Request could not be completed." });
    },
  );

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const invalidRequests = [
    {
      requestId: randomUUID(),
      setupSnapshot: { label: "", targetCases: 4 },
    },
    {
      requestId: randomUUID(),
      setupSnapshot: { label: "Invalid case count", targetCases: 0 },
    },
    {
      requestId: randomUUID(),
      setupSnapshot: {
        label: "Unsupported case count",
        targetCases: 2_147_483_648,
      },
    },
  ];

  try {
    for (const body of invalidRequests) {
      const response = await fetch(`${origin}/v2/runs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `v2_session=${session.token}`,
          origin,
          "x-csrf-token": session.csrfToken,
        },
        body: JSON.stringify(body),
      });
      assert.equal(
        response.status,
        400,
        "invalid run setup must be a client error",
      );
    }

    const savedRuns = await db
      .select()
      .from(productionRunsTable)
      .where(eq(productionRunsTable.facilityId, facility.id));
    const savedReceipts = await db
      .select()
      .from(runCreateReceiptsTable)
      .where(eq(runCreateReceiptsTable.facilityId, facility.id));
    assert.deepEqual(savedRuns, [], "invalid requests must not create runs");
    assert.deepEqual(
      savedReceipts,
      [],
      "invalid requests must not create run-creation receipts",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("signed HTTP requests enforce current facility roles without rotating the session", async () => {
  const [facility] = await db
    .insert(facilitiesTable)
    .values({ name: "Signed API role integration facility" })
    .returning();
  const ownerId = `http-owner-${randomUUID()}`;
  const operatorId = `http-operator-${randomUUID()}`;
  const operatorStationId = "operator-line-station";
  const memberships = await db
    .insert(facilityMembersTable)
    .values([
      { facilityId: facility.id, userId: ownerId, role: "owner" },
      { facilityId: facility.id, userId: operatorId, role: "operator" },
    ])
    .returning({
      id: facilityMembersTable.id,
      userId: facilityMembersTable.userId,
    });
  const operatorMembership = memberships.find(
    (membership) => membership.userId === operatorId,
  );
  assert.ok(operatorMembership);
  await db.insert(facilityStationLayoutsTable).values({
    facilityId: facility.id,
    revision: 0,
    stations: [
      {
        id: operatorStationId,
        name: "Operator line",
        area: "production_line",
        isActive: true,
      },
    ],
  });

  const clerkSessionId = `http-clerk-session-${randomUUID()}`;
  const ownerClerkSessionId = `http-owner-clerk-session-${randomUUID()}`;
  const v2Session = issueV2Session(operatorId, clerkSessionId);
  const ownerSession = issueV2Session(ownerId, ownerClerkSessionId);
  const initialRun = await createPlannedRun({
    facilityId: facility.id,
    actorUserId: ownerId,
    requestId: randomUUID(),
    setupSnapshot: { label: "Operator lifecycle run", targetCases: 4 },
  });
  const run = initialRun.run;

  let authenticatedIdentity = { userId: operatorId, sessionId: clerkSessionId };
  const app = express();
  app.use(express.json(), cookieParser());
  app.use((req, _res, next) => {
    const authHandler = Object.assign(
      () => ({
        userId: authenticatedIdentity.userId,
        sessionId: authenticatedIdentity.sessionId,
        tokenType: "session_token" as const,
      }),
      { [Symbol.for("@clerk/express.auth")]: true },
    );
    (req as Request & { auth: typeof authHandler }).auth = authHandler;
    next();
  });
  app.use(productionRouter);
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof HttpError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: "Request could not be completed." });
    },
  );

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const send = async (
    path: string,
    body: unknown,
    session = v2Session,
    method = "POST",
  ) =>
    fetch(`${origin}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        cookie: `v2_session=${session.token}`,
        origin,
        "x-csrf-token": session.csrfToken,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  try {
    const deniedCreateRequestId = randomUUID();
    const deniedCreateLabel = "Operator create attempt";
    const deniedCreate = await send("/v2/runs", {
      requestId: deniedCreateRequestId,
      setupSnapshot: { label: deniedCreateLabel, targetCases: 4 },
    });
    assert.equal(deniedCreate.status, 403);
    assert.deepEqual(
      await db
        .select()
        .from(productionRunsTable)
        .where(
          and(
            eq(productionRunsTable.facilityId, facility.id),
            eq(productionRunsTable.name, deniedCreateLabel),
          ),
        ),
      [],
      "a forbidden run create must not persist a production run",
    );
    assert.deepEqual(
      await db
        .select()
        .from(runCreateReceiptsTable)
        .where(
          and(
            eq(runCreateReceiptsTable.facilityId, facility.id),
            eq(runCreateReceiptsTable.requestId, deniedCreateRequestId),
          ),
        ),
      [],
      "a forbidden run create must not persist a creation receipt",
    );

    const command = (commandType: string, expectedRevision: number) =>
      send(`/v2/runs/${run.id}/commands`, {
        commandId: `${commandType}-${randomUUID()}`,
        commandType,
        expectedRevision,
      });

    const stationUpdate = {
      commandId: randomUUID(),
      expectedRevision: 0,
      producedCount: 4,
      preparationStatus: "in_progress",
    };
    const savedStation = await send(
      `/v2/runs/${run.id}/stations/${operatorStationId}`,
      stationUpdate,
      v2Session,
      "PATCH",
    );
    assert.equal(savedStation.status, 200, "operators can record station progress");
    const savedStationBody = (await savedStation.json()) as {
      station: { producedCount: number; preparationStatus: string; revision: number };
      replayed: boolean;
    };
    assert.equal(savedStationBody.station.producedCount, 4);
    assert.equal(savedStationBody.station.preparationStatus, "in_progress");
    assert.equal(savedStationBody.station.revision, 1);
    assert.equal(savedStationBody.replayed, false);
    const retriedStation = await send(
      `/v2/runs/${run.id}/stations/${operatorStationId}`,
      stationUpdate,
      v2Session,
      "PATCH",
    );
    assert.equal(retriedStation.status, 200, "station retries return the saved result");
    assert.equal(
      ((await retriedStation.json()) as { replayed: boolean }).replayed,
      true,
    );

    const started = await command("start", 0);
    assert.equal(started.status, 200, "operators can start runs");
    assert.equal(
      ((await started.json()) as { run: { status: string } }).run.status,
      "running",
    );

    const paused = await command("pause", 1);
    assert.equal(paused.status, 200, "operators can pause runs");
    assert.equal(
      ((await paused.json()) as { run: { status: string } }).run.status,
      "paused",
    );

    const resumed = await command("resume", 2);
    assert.equal(resumed.status, 200, "operators can resume runs");
    assert.equal(
      ((await resumed.json()) as { run: { status: string } }).run.status,
      "running",
    );

    const deniedComplete = await command("complete", 3);
    assert.equal(deniedComplete.status, 403);

    await db
      .update(facilityMembersTable)
      .set({ role: "manager" })
      .where(
        and(
          eq(facilityMembersTable.facilityId, facility.id),
          eq(facilityMembersTable.userId, operatorId),
        ),
      );

    const promotedCreate = await send("/v2/runs", {
      requestId: randomUUID(),
      setupSnapshot: { label: "Manager create attempt", targetCases: 4 },
      createdBy: ownerId,
    });
    assert.equal(promotedCreate.status, 201);
    const promotedCreateBody = (await promotedCreate.json()) as {
      run: { id: string };
    };
    const [savedPromotedRun] = await db
      .select()
      .from(productionRunsTable)
      .where(eq(productionRunsTable.id, promotedCreateBody.run.id))
      .limit(1);
    assert.ok(savedPromotedRun, "the authenticated create should persist a run");
    assert.equal(
      savedPromotedRun.createdBy,
      operatorId,
      "new runs must record the signed-in creator, not a client-supplied identity",
    );
    const promotedComplete = await command("complete", 3);
    assert.equal(promotedComplete.status, 200);
    assert.equal(
      ((await promotedComplete.json()) as { run: { status: string } }).run
        .status,
      "completed",
    );

    await db
      .update(facilityMembersTable)
      .set({ role: "operator" })
      .where(
        and(
          eq(facilityMembersTable.facilityId, facility.id),
          eq(facilityMembersTable.userId, operatorId),
        ),
      );

    const demotedCreate = await send("/v2/runs", {
      requestId: randomUUID(),
      setupSnapshot: { label: "Demoted create attempt", targetCases: 4 },
    });
    assert.equal(demotedCreate.status, 403);
    const demotedComplete = await command("complete", 4);
    assert.equal(demotedComplete.status, 403);

    authenticatedIdentity = {
      userId: ownerId,
      sessionId: ownerClerkSessionId,
    };
    const removed = await send(
      `/facility/members/${operatorMembership.id}`,
      undefined,
      ownerSession,
      "DELETE",
    );
    assert.equal(removed.status, 204);

    authenticatedIdentity = { userId: operatorId, sessionId: clerkSessionId };
    const historyBeforeDeniedRequests = {
      runs: await db
        .select()
        .from(productionRunsTable)
        .where(eq(productionRunsTable.facilityId, facility.id)),
      events: await db
        .select()
        .from(runEventsTable)
        .where(eq(runEventsTable.facilityId, facility.id)),
      createReceipts: await db
        .select()
        .from(runCreateReceiptsTable)
        .where(eq(runCreateReceiptsTable.facilityId, facility.id)),
      commandReceipts: await db
        .select()
        .from(runCommandReceiptsTable)
        .where(eq(runCommandReceiptsTable.facilityId, facility.id)),
      outbox: await db
        .select()
        .from(runOutboxTable)
        .where(eq(runOutboxTable.facilityId, facility.id)),
    };

    const removedMemberCreate = await send("/v2/runs", {
      requestId: randomUUID(),
      setupSnapshot: { label: "Removed member create attempt", targetCases: 4 },
    });
    assert.equal(removedMemberCreate.status, 403);
    const removedMemberCommand = await command("start", 4);
    assert.equal(removedMemberCommand.status, 403);

    assert.deepEqual(
      {
        runs: await db
          .select()
          .from(productionRunsTable)
          .where(eq(productionRunsTable.facilityId, facility.id)),
        events: await db
          .select()
          .from(runEventsTable)
          .where(eq(runEventsTable.facilityId, facility.id)),
        createReceipts: await db
          .select()
          .from(runCreateReceiptsTable)
          .where(eq(runCreateReceiptsTable.facilityId, facility.id)),
        commandReceipts: await db
          .select()
          .from(runCommandReceiptsTable)
          .where(eq(runCommandReceiptsTable.facilityId, facility.id)),
        outbox: await db
          .select()
          .from(runOutboxTable)
          .where(eq(runOutboxTable.facilityId, facility.id)),
      },
      historyBeforeDeniedRequests,
      "denied requests from a removed member must not change run history",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("station progress saves counts safely and stays on the line timer", async () => {
  const [facility] = await db
    .insert(facilitiesTable)
    .values({ name: "Station progress test facility" })
    .returning();
  const actorUserId = `station-progress-user-${randomUUID()}`;
  const stationId = "prep-dough";
  await db.insert(facilityStationLayoutsTable).values({
    facilityId: facility.id,
    revision: 0,
    stations: [
      { id: stationId, name: "Dough prep", area: "dough_sauce_prep", isActive: true },
      { id: "archived-packer", name: "Old packer", area: "freezing_packaging", isActive: false },
    ],
  });
  const created = await createPlannedRun({
    facilityId: facility.id,
    actorUserId,
    requestId: randomUUID(),
    setupSnapshot: { label: "Station progress run", targetCases: 30 },
  });
  assert.equal(created.outcome, "created");
  if (created.outcome !== "created") return;

  const preview = await getRunStationProgress({
    facilityId: facility.id,
    runId: created.run.id,
  });
  assert.equal(preview.initialized, false);
  assert.deepEqual(preview.stations.map((station) => station.stationId), [stationId]);
  assert.equal(preview.stations[0].producedCount, 0);
  assert.equal(preview.stations[0].preparationStatus, "not_started");

  const update = {
    commandId: randomUUID(),
    expectedRevision: 0,
    producedCount: 12,
    preparationStatus: "ready" as const,
  };
  const saved = await updateRunStationProgress({
    facilityId: facility.id,
    actorUserId,
    runId: created.run.id,
    stationId,
    update,
  });
  assert.equal(saved.outcome, "accepted");
  if (saved.outcome !== "accepted") return;
  assert.equal(saved.replayed, false);
  assert.equal(saved.station.producedCount, 12);
  assert.equal(saved.station.preparationStatus, "ready");
  assert.equal(saved.station.revision, 1);

  const retry = await updateRunStationProgress({
    facilityId: facility.id,
    actorUserId,
    runId: created.run.id,
    stationId,
    update,
  });
  assert.equal(retry.outcome, "accepted");
  if (retry.outcome !== "accepted") return;
  assert.equal(retry.replayed, true);
  assert.equal(retry.station.revision, 1);

  const stale = await updateRunStationProgress({
    facilityId: facility.id,
    actorUserId: `${actorUserId}-second-device`,
    runId: created.run.id,
    stationId,
    update: { ...update, commandId: randomUUID(), producedCount: 99 },
  });
  assert.equal(stale.outcome, "conflict");
  if (stale.outcome !== "conflict") return;
  assert.equal(stale.current.producedCount, 12);
  assert.equal(stale.current.revision, 1);
  await assert.rejects(
    updateRunStationProgress({
      facilityId: randomUUID(),
      actorUserId,
      runId: created.run.id,
      stationId,
      update: { ...update, commandId: randomUUID() },
    }),
    (error: unknown) =>
      Boolean(error && typeof error === "object" && "statusCode" in error && error.statusCode === 404),
  );

  const [runBeforeStart] = await db
    .select()
    .from(productionRunsTable)
    .where(eq(productionRunsTable.id, created.run.id))
    .limit(1);
  assert.equal(runBeforeStart.status, "planned");
  assert.equal(runBeforeStart.startedAt, null);

  const started = await executeRunCommand({
    facilityId: facility.id,
    actorUserId,
    runId: created.run.id,
    command: { commandId: randomUUID(), commandType: "start", expectedRevision: 0 },
  });
  assert.equal(started.outcome, "accepted");
  const running = await getRunStationProgress({ facilityId: facility.id, runId: created.run.id });
  assert.equal(running.stations[0].status, "in_progress");
  assert.equal(running.stations[0].producedCount, 12);
  assert.equal(running.stations[0].preparationStatus, "ready");

  const paused = await executeRunCommand({
    facilityId: facility.id,
    actorUserId,
    runId: created.run.id,
    command: { commandId: randomUUID(), commandType: "pause", expectedRevision: 1 },
  });
  assert.equal(paused.outcome, "accepted");
  const pausedProgress = await getRunStationProgress({ facilityId: facility.id, runId: created.run.id });
  assert.equal(pausedProgress.stations[0].status, "paused");
  assert.equal(pausedProgress.stations[0].producedCount, 12);
  assert.equal(pausedProgress.stations[0].preparationStatus, "ready");
  const [stationRow] = await db
    .select()
    .from(runStationProgressTable)
    .where(eq(runStationProgressTable.runId, created.run.id))
    .limit(1);
  assert.equal(stationRow.revision, 3);
});

test("operators confirm source-based usage once and managers append linked corrections", async () => {
  const [facility] = await db
    .insert(facilitiesTable)
    .values({ name: "Inventory reconciliation test facility" })
    .returning();
  const ownerId = `inventory-owner-${randomUUID()}`;
  const operatorId = `inventory-operator-${randomUUID()}`;
  const ownerClerkSessionId = `inventory-owner-session-${randomUUID()}`;
  const operatorClerkSessionId = `inventory-operator-session-${randomUUID()}`;
  await db.insert(facilityMembersTable).values([
    { facilityId: facility.id, userId: ownerId, role: "owner" },
    { facilityId: facility.id, userId: operatorId, role: "operator" },
  ]);
  const ownerSession = issueV2Session(ownerId, ownerClerkSessionId);
  const operatorSession = issueV2Session(operatorId, operatorClerkSessionId);
  let currentActorId = ownerId;
  let currentClerkSessionId = ownerClerkSessionId;
  const app = express();
  app.use(express.json(), cookieParser());
  app.use((req, _res, next) => {
    const authHandler = Object.assign(
      () => ({
        userId: currentActorId,
        sessionId: currentClerkSessionId,
        tokenType: "session_token" as const,
      }),
      { [Symbol.for("@clerk/express.auth")]: true },
    );
    (req as Request & { auth: typeof authHandler }).auth = authHandler;
    next();
  });
  app.use(productionRouter);
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      if (error instanceof HttpError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: "Request could not be completed." });
    },
  );
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const request = (
    session: typeof ownerSession | typeof operatorSession,
    path: string,
    method = "GET",
    body?: unknown,
  ) => fetch(`${origin}${path}`, {
    method,
    headers: {
      cookie: `v2_session=${session.token}`,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(method === "GET" ? {} : {
        origin,
        "x-csrf-token": session.csrfToken,
      }),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  try {
    const openingStock = await request(ownerSession, "/v2/inventory", "POST", {
      commandId: randomUUID(),
      ingredientName: "Cheese",
      unit: "lb",
      delta: 5,
      note: "Opening count for the shift",
      correctsEntryId: null,
    });
    assert.equal(openingStock.status, 201);

    const now = new Date();
    const [run] = await db
      .insert(productionRunsTable)
      .values({
        facilityId: facility.id,
        name: "Completed inventory run",
        targetCases: 10,
        status: "completed",
        revision: 1,
        productSnapshot: {
          runRequirements: {
            targetCases: 10,
            items: [
              {
                id: "cheese-use",
                name: "Cheese",
                originalName: "Cheese",
                source: "Specs.xlsx · row 4",
                station: "Production line",
                stationArea: "production_line",
                amountChoices: [],
                amountColumn: "Amount",
                usageUnit: "lb",
                perPizza: 1,
                totalRequired: 10,
                recipeId: null,
                recipeSource: null,
                directIngredient: true,
                batchColumn: null,
                batchUnit: null,
                batchYield: null,
                batchesExact: null,
                wholeBatches: null,
                remainder: null,
                ingredients: [],
                instructions: [],
                issues: [],
              },
              {
                id: "unresolved-use",
                name: "Unknown ingredient",
                originalName: "Unknown ingredient",
                source: "Specs.xlsx · row 5",
                station: "Production line",
                stationArea: "production_line",
                amountChoices: [],
                amountColumn: null,
                usageUnit: null,
                perPizza: null,
                totalRequired: null,
                recipeId: null,
                recipeSource: null,
                directIngredient: true,
                batchColumn: null,
                batchUnit: null,
                batchYield: null,
                batchesExact: null,
                wholeBatches: null,
                remainder: null,
                ingredients: [],
                instructions: [],
                issues: ["Confirm the source unit."],
              },
            ],
            batchPreparation: [],
          },
        },
        createdBy: ownerId,
      })
      .returning();
    await db.insert(runStationProgressTable).values({
      runId: run.id,
      stationId: "line",
      stationName: "Line",
      stationArea: "production_line",
      stationOrder: 0,
      status: "completed",
      completedCases: 5,
      countUpdatedAt: now,
      updatedAt: now,
      updatedBy: ownerId,
    });

    currentActorId = operatorId;
    currentClerkSessionId = operatorClerkSessionId;
    const path = `/v2/runs/${run.id}/inventory-usage`;
    const proposedResponse = await request(operatorSession, path);
    assert.equal(proposedResponse.status, 200);
    const proposal = await proposedResponse.json() as {
      canConfirm: boolean;
      blockedCount: number;
      items: Array<{ id: string; unit: string; proposedQuantity: number | null; blockedReason: string | null }>;
    };
    assert.equal(proposal.canConfirm, true);
    assert.equal(proposal.blockedCount, 1);
    const cheese = proposal.items.find((item) => item.unit === "lb");
    assert.ok(cheese);
    assert.equal(cheese.proposedQuantity, 5);
    assert.equal(cheese.blockedReason, null);
    assert.ok(proposal.items.some((item) => item.blockedReason !== null));

    const deniedStockChange = await request(operatorSession, "/v2/inventory", "POST", {
      commandId: randomUUID(),
      ingredientName: "Cheese",
      unit: "lb",
      delta: 2,
      note: "Operator should not edit stock",
      correctsEntryId: null,
    });
    assert.equal(deniedStockChange.status, 403);

    const confirmation = {
      commandId: randomUUID(),
      items: [{ id: cheese.id, actualUsed: 3.5 }],
    };
    const confirmedResponse = await request(operatorSession, path, "POST", confirmation);
    assert.equal(confirmedResponse.status, 200);
    const confirmed = await confirmedResponse.json() as {
      reconciliation: { entries: Array<{ actualUsed: number | null }> } | null;
      items: Array<{ inventoryOnHand: number | null }>;
    };
    assert.equal(confirmed.reconciliation?.entries[0]?.actualUsed, 3.5);
    assert.equal(confirmed.items.find((item) => item.inventoryOnHand !== null)?.inventoryOnHand, 1.5);

    const replay = await request(operatorSession, path, "POST", confirmation);
    assert.equal(replay.status, 200, "same confirmation key and values are safe to retry");
    const duplicate = await request(operatorSession, path, "POST", {
      ...confirmation,
      commandId: randomUUID(),
    });
    assert.equal(duplicate.status, 409, "a run cannot deduct confirmed usage twice");

    currentActorId = ownerId;
    currentClerkSessionId = ownerClerkSessionId;
    const [usageEntry] = await db
      .select()
      .from(inventoryTransactionsTable)
      .where(eq(inventoryTransactionsTable.runId, run.id))
      .limit(1);
    assert.ok(usageEntry);
    const correction = await request(ownerSession, "/v2/inventory", "POST", {
      commandId: randomUUID(),
      ingredientName: "Cheese",
      unit: "lb",
      delta: 0.5,
      note: "Correct the measured amount",
      correctsEntryId: usageEntry.id,
    });
    assert.equal(correction.status, 201);
    const inventory = await getFacilityInventory(facility.id);
    assert.equal(inventory.items.find((item) => item.ingredientName === "Cheese")?.onHand, 2);
    assert.ok(inventory.entries.some((entry) => entry.correctsEntryId === usageEntry.id));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
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
        "488e49dfb13955da2f90e119cf91185174b8f9b1acad295ad59dc662bbec3541",
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
  const runsBeforeChangedLegacyRetry = await db
    .select({ id: productionRunsTable.id })
    .from(productionRunsTable)
    .where(eq(productionRunsTable.facilityId, legacyCreateReceipt.facilityId));
  await assert.rejects(
    createPlannedRun({
      facilityId: legacyCreateReceipt.facilityId,
      actorUserId: legacyCreateReceipt.actorUserId,
      requestId: legacyCreateReceipt.requestId,
      setupSnapshot: { label: "Changed legacy details", targetCases: 1 },
    }),
    (error: unknown) =>
      error instanceof Error &&
      "statusCode" in error &&
      error.statusCode === 409 &&
      error.message ===
        "This request ID was already used for different run details.",
    "a changed retry must return the existing request-details conflict",
  );
  const runsAfterChangedLegacyRetry = await db
    .select({ id: productionRunsTable.id })
    .from(productionRunsTable)
    .where(eq(productionRunsTable.facilityId, legacyCreateReceipt.facilityId));
  assert.equal(
    runsAfterChangedLegacyRetry.length,
    runsBeforeChangedLegacyRetry.length,
    "a changed retry must not create another run after upgrade",
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
    productProfileId: null,
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

test("deleting a run clears only its lifecycle history and pending notifications", async () => {
  const [facility] = await db
    .insert(facilitiesTable)
    .values({ name: "Run history deletion facility" })
    .returning();
  const actorUserId = `run-history-deletion-user-${randomUUID()}`;
  const deletedRun = await createPlannedRun({
    facilityId: facility.id,
    actorUserId,
    requestId: randomUUID(),
    setupSnapshot: { label: "Run to delete", targetCases: 10 },
  });
  const preservedRun = await createPlannedRun({
    facilityId: facility.id,
    actorUserId,
    requestId: randomUUID(),
    setupSnapshot: { label: "Run to preserve", targetCases: 12 },
  });
  assert.equal(deletedRun.outcome, "created");
  assert.equal(preservedRun.outcome, "created");

  for (const run of [deletedRun.run, preservedRun.run]) {
    const started = await executeRunCommand({
      facilityId: facility.id,
      actorUserId,
      runId: run.id,
      command: {
        commandId: `start-${randomUUID()}`,
        commandType: "start",
        expectedRevision: 0,
      },
    });
    assert.equal(started.outcome, "accepted");

    const paused = await executeRunCommand({
      facilityId: facility.id,
      actorUserId,
      runId: run.id,
      command: {
        commandId: `pause-${randomUUID()}`,
        commandType: "pause",
        expectedRevision: 1,
      },
    });
    assert.equal(paused.outcome, "accepted");
  }

  const getRunHistory = async (runId: string) => {
    const [events, receipts, outbox] = await Promise.all([
      db.select().from(runEventsTable).where(eq(runEventsTable.runId, runId)),
      db
        .select()
        .from(runCommandReceiptsTable)
        .where(eq(runCommandReceiptsTable.runId, runId)),
      db.select().from(runOutboxTable).where(eq(runOutboxTable.runId, runId)),
    ]);
    return { events, receipts, outbox };
  };
  const deletedHistoryBefore = await getRunHistory(deletedRun.run.id);
  const preservedHistoryBefore = await getRunHistory(preservedRun.run.id);

  assert.deepEqual(
    deletedHistoryBefore.events.map((event) => event.action),
    ["start", "pause"],
    "the run selected for deletion should have lifecycle history",
  );
  assert.equal(
    deletedHistoryBefore.receipts.length,
    2,
    "the run selected for deletion should have both command receipts",
  );
  assert.equal(
    deletedHistoryBefore.outbox.length,
    2,
    "the run selected for deletion should have both notifications",
  );
  assert.ok(
    deletedHistoryBefore.outbox.every(
      (notification) => notification.deliveredAt === null,
    ),
    "the run selected for deletion should have pending notifications",
  );
  assert.deepEqual(
    preservedHistoryBefore.events.map((event) => event.action),
    ["start", "pause"],
    "the other run should also have lifecycle history",
  );
  assert.equal(
    preservedHistoryBefore.receipts.length,
    2,
    "the other run should have both command receipts",
  );
  assert.equal(
    preservedHistoryBefore.outbox.length,
    2,
    "the other run should have both notifications",
  );
  assert.ok(
    preservedHistoryBefore.outbox.every(
      (notification) => notification.deliveredAt === null,
    ),
    "the other run should have pending notifications before deletion",
  );

  await db
    .delete(productionRunsTable)
    .where(eq(productionRunsTable.id, deletedRun.run.id));

  const deletedHistoryAfter = await getRunHistory(deletedRun.run.id);

  assert.deepEqual(
    deletedHistoryAfter.events,
    [],
    "deleting the run should remove its lifecycle history",
  );
  assert.deepEqual(
    deletedHistoryAfter.receipts,
    [],
    "deleting the run should remove its command receipts",
  );
  assert.deepEqual(
    deletedHistoryAfter.outbox,
    [],
    "deleting the run should remove pending notifications",
  );
  assert.deepEqual(
    await getRunHistory(preservedRun.run.id),
    preservedHistoryBefore,
    "deleting one run should preserve the other run's linked history",
  );
});

test("run creation rolls back the run when its retry receipt write fails", async () => {
  const [facility] = await db
    .insert(facilitiesTable)
    .values({ name: "Run creation rollback facility" })
    .returning();
  const actorUserId = `run-create-rollback-user-${randomUUID()}`;
  const requestId = randomUUID();

  await pool.query(`
    CREATE FUNCTION fail_test_run_create_receipt() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.request_id = '${requestId}' THEN
        RAISE EXCEPTION 'intentional run creation receipt failure';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER fail_test_run_create_receipt
      BEFORE INSERT ON run_create_receipts
      FOR EACH ROW EXECUTE FUNCTION fail_test_run_create_receipt();
  `);

  try {
    await assert.rejects(
      createPlannedRun({
        facilityId: facility.id,
        actorUserId,
        requestId,
        setupSnapshot: { label: "Run whose receipt fails", targetCases: 7 },
      }),
      (error: unknown) =>
        error instanceof Error &&
        (error.message.includes("intentional run creation receipt failure") ||
          (error.cause instanceof Error &&
            error.cause.message.includes(
              "intentional run creation receipt failure",
            ))),
    );

    const runsAfter = await db
      .select()
      .from(productionRunsTable)
      .where(eq(productionRunsTable.facilityId, facility.id));
    const receiptsAfter = await db
      .select()
      .from(runCreateReceiptsTable)
      .where(
        and(
          eq(runCreateReceiptsTable.facilityId, facility.id),
          eq(runCreateReceiptsTable.actorUserId, actorUserId),
          eq(runCreateReceiptsTable.requestId, requestId),
        ),
      );

    assert.deepEqual(runsAfter, [], "the newly inserted run should roll back");
    assert.deepEqual(
      receiptsAfter,
      [],
      "the failed retry receipt should not be partially recorded",
    );
  } finally {
    await pool.query(`
      DROP TRIGGER IF EXISTS fail_test_run_create_receipt ON run_create_receipts;
      DROP FUNCTION IF EXISTS fail_test_run_create_receipt();
    `);
  }
});

test("deleting a run removes its create receipt and allows a retry to recreate it", async () => {
  const [facility] = await db
    .insert(facilitiesTable)
    .values({ name: "Run creation deletion facility" })
    .returning();
  const actorUserId = `run-create-deletion-user-${randomUUID()}`;
  const requestId = randomUUID();
  const setupSnapshot = { label: "Replaceable run", targetCases: 8 };

  const original = await createPlannedRun({
    facilityId: facility.id,
    actorUserId,
    requestId,
    setupSnapshot,
  });
  assert.equal(original.replayed, false);

  const originalReceipt = await db
    .select()
    .from(runCreateReceiptsTable)
    .where(
      and(
        eq(runCreateReceiptsTable.facilityId, facility.id),
        eq(runCreateReceiptsTable.actorUserId, actorUserId),
        eq(runCreateReceiptsTable.requestId, requestId),
      ),
    );
  assert.equal(originalReceipt.length, 1);
  assert.equal(originalReceipt[0].runId, original.run.id);

  await db
    .delete(productionRunsTable)
    .where(eq(productionRunsTable.id, original.run.id));

  const deletedRuns = await db
    .select()
    .from(productionRunsTable)
    .where(eq(productionRunsTable.id, original.run.id));
  const deletedReceipts = await db
    .select()
    .from(runCreateReceiptsTable)
    .where(
      and(
        eq(runCreateReceiptsTable.facilityId, facility.id),
        eq(runCreateReceiptsTable.actorUserId, actorUserId),
        eq(runCreateReceiptsTable.requestId, requestId),
      ),
    );
  assert.deepEqual(deletedRuns, [], "the original run should be deleted");
  assert.deepEqual(
    deletedReceipts,
    [],
    "deleting the run should cascade to its create receipt",
  );

  const retry = await createPlannedRun({
    facilityId: facility.id,
    actorUserId,
    requestId,
    setupSnapshot,
  });
  assert.equal(retry.replayed, false);
  assert.notEqual(
    retry.run.id,
    original.run.id,
    "a retry after deletion should create a replacement run",
  );

  const replacementReplay = await createPlannedRun({
    facilityId: facility.id,
    actorUserId,
    requestId,
    setupSnapshot,
  });
  assert.equal(replacementReplay.replayed, true);
  assert.equal(
    replacementReplay.run.id,
    retry.run.id,
    "later retries should resolve to the replacement run",
  );

  const remainingRuns = await db
    .select()
    .from(productionRunsTable)
    .where(eq(productionRunsTable.facilityId, facility.id));
  const replacementReceipts = await db
    .select()
    .from(runCreateReceiptsTable)
    .where(
      and(
        eq(runCreateReceiptsTable.facilityId, facility.id),
        eq(runCreateReceiptsTable.actorUserId, actorUserId),
        eq(runCreateReceiptsTable.requestId, requestId),
      ),
    );
  assert.deepEqual(
    remainingRuns.map((run) => run.id),
    [retry.run.id],
    "only the replacement run should remain",
  );
  assert.equal(replacementReceipts.length, 1);
  assert.equal(replacementReceipts[0].runId, retry.run.id);
});

test("run creation retries are isolated by user and facility", async () => {
  const [firstFacility, secondFacility] = await db
    .insert(facilitiesTable)
    .values([
      { name: "First retry isolation facility" },
      { name: "Second retry isolation facility" },
    ])
    .returning();
  const firstUserId = `run-create-retry-user-${randomUUID()}`;
  const secondUserId = `run-create-retry-user-${randomUUID()}`;
  const requestId = randomUUID();
  const firstSetup = { label: "First user's run", targetCases: 3 };
  const secondUserSetup = { label: "Second user's run", targetCases: 5 };
  const secondFacilitySetup = {
    label: "Run in second facility",
    targetCases: 7,
  };

  const firstRun = await createPlannedRun({
    facilityId: firstFacility.id,
    actorUserId: firstUserId,
    requestId,
    setupSnapshot: firstSetup,
  });
  const secondUserRun = await createPlannedRun({
    facilityId: firstFacility.id,
    actorUserId: secondUserId,
    requestId,
    setupSnapshot: secondUserSetup,
  });
  const secondFacilityRun = await createPlannedRun({
    facilityId: secondFacility.id,
    actorUserId: firstUserId,
    requestId,
    setupSnapshot: secondFacilitySetup,
  });

  assert.equal(firstRun.replayed, false);
  assert.equal(secondUserRun.replayed, false);
  assert.equal(secondFacilityRun.replayed, false);
  assert.notEqual(firstRun.run.id, secondUserRun.run.id);
  assert.notEqual(firstRun.run.id, secondFacilityRun.run.id);
  assert.notEqual(secondUserRun.run.id, secondFacilityRun.run.id);

  const firstUserRetry = await createPlannedRun({
    facilityId: firstFacility.id,
    actorUserId: firstUserId,
    requestId,
    setupSnapshot: firstSetup,
  });
  const secondUserRetry = await createPlannedRun({
    facilityId: firstFacility.id,
    actorUserId: secondUserId,
    requestId,
    setupSnapshot: secondUserSetup,
  });
  const secondFacilityRetry = await createPlannedRun({
    facilityId: secondFacility.id,
    actorUserId: firstUserId,
    requestId,
    setupSnapshot: secondFacilitySetup,
  });

  assert.equal(firstUserRetry.replayed, true);
  assert.equal(firstUserRetry.run.id, firstRun.run.id);
  assert.equal(secondUserRetry.replayed, true);
  assert.equal(secondUserRetry.run.id, secondUserRun.run.id);
  assert.equal(secondFacilityRetry.replayed, true);
  assert.equal(secondFacilityRetry.run.id, secondFacilityRun.run.id);
});
