import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
  db,
  facilitiesTable,
  facilityInvitationsTable,
  facilityMembersTable,
} from "@workspace/db";
import {
  acceptPendingFacilityInvitation,
  cancelPendingFacilityInvitation,
  FACILITY_INVITATION_METADATA_KEY,
  persistInvitationTrackingOrCleanup,
  resolveUntrackedClerkInvitation,
} from "../src/lib/facility-invitation-service";
import { getFacilityMembership } from "../src/lib/run-permissions";
import { pool } from "@workspace/db";

const invitationAcceptanceDependencies = {
  database: db,
  getEmailAddresses: async (userId: string) =>
    emailAddressesByUser.get(userId) ?? [],
  getMembership: getFacilityMembership,
};

const emailAddressesByUser = new Map<
  string,
  Array<{
    emailAddress: string;
    verification?: { status?: string } | null;
  }>
>();
let facilityId: string;

test("untracked Clerk invitations match by the facility record marker", () => {
  const invitation = {
    id: "facility-invitation-id",
    email: "owner@example.com",
    createdAt: new Date("2026-11-11T10:00:00.000Z"),
  };

  assert.deepEqual(
    resolveUntrackedClerkInvitation(invitation, [
      {
        id: "clerk-invitation-id",
        emailAddress: "OWNER@example.com",
        publicMetadata: {
          [FACILITY_INVITATION_METADATA_KEY]: invitation.id,
        },
        createdAt: new Date("2026-11-11T09:00:00.000Z").getTime(),
      },
    ]),
    { kind: "matched", invitationId: "clerk-invitation-id" },
  );
});

test("legacy invitation recovery requires one recent exact-email candidate", () => {
  const invitation = {
    id: "legacy-facility-invitation",
    email: "owner@example.com",
    createdAt: new Date("2026-11-11T10:00:00.000Z"),
  };
  const legacyClerkInvitation = {
    id: "legacy-clerk-invitation",
    emailAddress: "owner@example.com",
    publicMetadata: null,
    createdAt: new Date("2026-11-11T10:02:00.000Z").getTime(),
  };

  assert.deepEqual(
    resolveUntrackedClerkInvitation(invitation, [legacyClerkInvitation]),
    { kind: "matched", invitationId: "legacy-clerk-invitation" },
  );
  assert.deepEqual(
    resolveUntrackedClerkInvitation(invitation, [
      legacyClerkInvitation,
      { ...legacyClerkInvitation, id: "another-clerk-invitation" },
    ]),
    { kind: "unsafe" },
  );
  assert.deepEqual(
    resolveUntrackedClerkInvitation(invitation, [
      {
        ...legacyClerkInvitation,
        publicMetadata: {
          [FACILITY_INVITATION_METADATA_KEY]: "another-facility-invitation",
        },
      },
    ]),
    { kind: "unsafe" },
  );
  assert.deepEqual(
    resolveUntrackedClerkInvitation(invitation, [
      {
        ...legacyClerkInvitation,
        createdAt: invitation.createdAt.getTime() + 700_000,
      },
    ]),
    { kind: "unsafe" },
  );
});

test("an absent Clerk invitation is safe to reconcile, unrelated email is not", () => {
  const invitation = {
    id: "facility-invitation-id",
    email: "owner@example.com",
    createdAt: new Date(),
  };

  assert.deepEqual(resolveUntrackedClerkInvitation(invitation, []), {
    kind: "not-found",
  });
  assert.deepEqual(
    resolveUntrackedClerkInvitation(invitation, [
      {
        id: "other-email",
        emailAddress: "someone-else@example.com",
        createdAt: Date.now(),
      },
    ]),
    { kind: "not-found" },
  );
});

test("failed Clerk ID persistence revokes and removes the local invitation", async () => {
  const calls: string[] = [];

  const result = await persistInvitationTrackingOrCleanup({
    persist: async () => {
      calls.push("persist");
      throw new Error("database unavailable");
    },
    revoke: async () => {
      calls.push("revoke");
    },
    removeLocalRecord: async () => {
      calls.push("remove");
    },
  });

  assert.equal(result, "cleaned");
  assert.deepEqual(calls, ["persist", "revoke", "remove"]);
});

test("failed compensation leaves the invitation available for recovery", async () => {
  const result = await persistInvitationTrackingOrCleanup({
    persist: async () => false,
    revoke: async () => {
      throw new Error("Clerk unavailable");
    },
    removeLocalRecord: async () => {
      assert.fail("Local record must remain when Clerk revocation fails.");
    },
  });

  assert.equal(result, "recovery-required");
});

test("a cleaned Clerk invite remains recoverable if local deletion fails", async () => {
  const calls: string[] = [];
  const result = await persistInvitationTrackingOrCleanup({
    persist: async () => false,
    revoke: async () => {
      calls.push("revoke");
    },
    removeLocalRecord: async () => {
      calls.push("remove");
      throw new Error("database unavailable");
    },
  });

  assert.equal(result, "recovery-required");
  assert.deepEqual(calls, ["revoke", "remove"]);
});

beforeEach(async () => {
  emailAddressesByUser.clear();
  await db.delete(facilityInvitationsTable);
  await db.delete(facilityMembersTable);
  await db.delete(facilitiesTable);
  const [facility] = await db
    .insert(facilitiesTable)
    .values({ name: "Invitation acceptance fixture" })
    .returning({ id: facilitiesTable.id });
  facilityId = facility.id;
});

after(async () => {
  await pool.end();
});

async function createInvitation(
  email: string,
  role: "manager" | "operator",
  expiresAt = new Date(Date.now() + 60_000),
  clerkInvitationId: string | null = null,
) {
  const [invitation] = await db
    .insert(facilityInvitationsTable)
    .values({
      facilityId,
      email,
      role,
      invitedBy: "facility-owner",
      clerkInvitationId,
      expiresAt,
    })
    .returning({ id: facilityInvitationsTable.id });
  return invitation.id;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForInvitationLockWait() {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ waiting: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND query ILIKE '%facility_invitations%'
      ) AS waiting
    `);
    if (result.rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for an invitation row lock.");
}

for (const role of ["manager", "operator"] as const) {
  test(`verified invitee receives the stored ${role} role`, async () => {
    const userId = `verified-${role}`;
    await createInvitation("invitee@example.com", role);
    emailAddressesByUser.set(userId, [
      {
        emailAddress: " Invitee@Example.com ",
        verification: { status: "verified" },
      },
    ]);

    const membership = await acceptPendingFacilityInvitation(
      userId,
      invitationAcceptanceDependencies,
    );

    assert.equal(membership?.facilityId, facilityId);
    assert.equal(membership?.role, role);
    assert.equal(await db.$count(facilityMembersTable), 1);
    assert.equal(await db.$count(facilityInvitationsTable), 0);
  });
}

test("an unverified invited address cannot claim the invitation", async () => {
  await createInvitation("invitee@example.com", "manager");
  emailAddressesByUser.set("unverified-user", [
    {
      emailAddress: "invitee@example.com",
      verification: { status: "unverified" },
    },
    {
      emailAddress: "other@example.com",
      verification: { status: "verified" },
    },
  ]);

  const membership = await acceptPendingFacilityInvitation(
    "unverified-user",
    invitationAcceptanceDependencies,
  );

  assert.equal(membership, null);
  assert.equal(await db.$count(facilityMembersTable), 0);
  assert.equal(await db.$count(facilityInvitationsTable), 1);
});

test("a different verified address cannot claim the invitation", async () => {
  await createInvitation("invitee@example.com", "operator");
  emailAddressesByUser.set("different-user", [
    {
      emailAddress: "other@example.com",
      verification: { status: "verified" },
    },
  ]);

  const membership = await acceptPendingFacilityInvitation(
    "different-user",
    invitationAcceptanceDependencies,
  );

  assert.equal(membership, null);
  assert.equal(await db.$count(facilityMembersTable), 0);
  assert.equal(await db.$count(facilityInvitationsTable), 1);
});

test("an expired invitation cannot create a membership", async () => {
  await createInvitation(
    "invitee@example.com",
    "manager",
    new Date(Date.now() - 60_000),
  );
  emailAddressesByUser.set("expired-user", [
    {
      emailAddress: "invitee@example.com",
      verification: { status: "verified" },
    },
  ]);

  const membership = await acceptPendingFacilityInvitation(
    "expired-user",
    invitationAcceptanceDependencies,
  );

  assert.equal(membership, null);
  assert.equal(await db.$count(facilityMembersTable), 0);
  assert.equal(await db.$count(facilityInvitationsTable), 1);
});

test("repeated acceptance does not duplicate membership or change its role", async () => {
  const userId = "repeat-user";
  await createInvitation("first@example.com", "manager");
  emailAddressesByUser.set(userId, [
    {
      emailAddress: "first@example.com",
      verification: { status: "verified" },
    },
    {
      emailAddress: "second@example.com",
      verification: { status: "verified" },
    },
  ]);

  const firstAcceptance = await acceptPendingFacilityInvitation(
    userId,
    invitationAcceptanceDependencies,
  );
  await createInvitation("second@example.com", "operator");
  const repeatedAcceptance = await acceptPendingFacilityInvitation(
    userId,
    invitationAcceptanceDependencies,
  );

  assert.equal(firstAcceptance?.role, "manager");
  assert.equal(repeatedAcceptance?.role, "manager");
  assert.equal(await db.$count(facilityMembersTable), 1);
  assert.equal(await db.$count(facilityInvitationsTable), 1);
});

test("simultaneous acceptance creates one membership with the stored role", async () => {
  const userId = "simultaneous-claim-user";
  await createInvitation("simultaneous@example.com", "operator");
  emailAddressesByUser.set(userId, [
    {
      emailAddress: "simultaneous@example.com",
      verification: { status: "verified" },
    },
  ]);

  const invitationLocked = deferred();
  const finishFirstAcceptance = deferred();
  const firstAcceptance = acceptPendingFacilityInvitation(userId, {
    ...invitationAcceptanceDependencies,
    afterInvitationLocked: async () => {
      invitationLocked.resolve();
      await finishFirstAcceptance.promise;
    },
  });

  await invitationLocked.promise;
  const secondAcceptance = acceptPendingFacilityInvitation(
    userId,
    invitationAcceptanceDependencies,
  );

  let lockWaitError: unknown;
  try {
    await waitForInvitationLockWait();
    assert.equal(await db.$count(facilityMembersTable), 0);
    assert.equal(await db.$count(facilityInvitationsTable), 1);
  } catch (error) {
    lockWaitError = error;
  } finally {
    finishFirstAcceptance.resolve();
  }

  const [firstMembership, secondMembership] = await Promise.all([
    firstAcceptance,
    secondAcceptance,
  ]);
  if (lockWaitError) throw lockWaitError;

  assert.equal(firstMembership?.facilityId, facilityId);
  assert.equal(firstMembership?.role, "operator");
  assert.equal(secondMembership?.facilityId, facilityId);
  assert.equal(secondMembership?.role, "operator");
  assert.equal(await db.$count(facilityMembersTable), 1);
  assert.equal(await db.$count(facilityInvitationsTable), 0);
});

test("cancellation winning the invitation lock prevents facility access", async () => {
  const userId = "cancel-wins-user";
  const invitationId = await createInvitation(
    "cancel-wins@example.com",
    "operator",
    new Date(Date.now() + 60_000),
    "clerk-cancel-wins",
  );
  emailAddressesByUser.set(userId, [
    {
      emailAddress: "cancel-wins@example.com",
      verification: { status: "verified" },
    },
  ]);
  const revokeStarted = deferred();
  const finishRevoke = deferred();
  const cancellation = cancelPendingFacilityInvitation(
    facilityId,
    invitationId,
    {
      database: db,
      revokeInvitation: async () => {
        revokeStarted.resolve();
        await finishRevoke.promise;
      },
      resolveUntrackedInvitation: async () => ({ kind: "not-found" }),
    },
  );

  await revokeStarted.promise;
  const acceptance = acceptPendingFacilityInvitation(
    userId,
    invitationAcceptanceDependencies,
  );
  await waitForInvitationLockWait();
  finishRevoke.resolve();

  assert.equal(await cancellation, "cancelled");
  assert.equal(await acceptance, null);
  assert.equal(await db.$count(facilityMembersTable), 0);
  assert.equal(await db.$count(facilityInvitationsTable), 0);
});

test("a cancelled invitation cannot be accepted while a later valid invitation still can", async () => {
  const cancelledUserId = "cancelled-invitee";
  const cancelledInvitationId = await createInvitation(
    "cancelled-invitee@example.com",
    "operator",
    new Date(Date.now() + 60_000),
    "clerk-cancelled-invite",
  );
  emailAddressesByUser.set(cancelledUserId, [
    {
      emailAddress: "cancelled-invitee@example.com",
      verification: { status: "verified" },
    },
  ]);

  const cancellation = await cancelPendingFacilityInvitation(
    facilityId,
    cancelledInvitationId,
    {
      database: db,
      revokeInvitation: async () => {},
    },
  );
  const cancelledAcceptance = await acceptPendingFacilityInvitation(
    cancelledUserId,
    invitationAcceptanceDependencies,
  );

  assert.equal(cancellation, "cancelled");
  assert.equal(cancelledAcceptance, null);
  assert.equal(await getFacilityMembership(cancelledUserId), null);
  assert.equal(await db.$count(facilityMembersTable), 0);
  assert.equal(await db.$count(facilityInvitationsTable), 0);

  const laterUserId = "later-valid-invitee";
  await createInvitation(
    "later-invitee@example.com",
    "manager",
    new Date(Date.now() + 60_000),
    "clerk-later-valid-invite",
  );
  emailAddressesByUser.set(laterUserId, [
    {
      emailAddress: "later-invitee@example.com",
      verification: { status: "verified" },
    },
  ]);

  const laterAcceptance = await acceptPendingFacilityInvitation(
    laterUserId,
    invitationAcceptanceDependencies,
  );

  assert.equal(laterAcceptance?.facilityId, facilityId);
  assert.equal(laterAcceptance?.role, "manager");
  assert.equal(await getFacilityMembership(cancelledUserId), null);
  assert.equal(await db.$count(facilityMembersTable), 1);
  assert.equal(await db.$count(facilityInvitationsTable), 0);
});

test("acceptance winning the invitation lock makes cancellation report not found", async () => {
  const userId = "accept-wins-user";
  const invitationId = await createInvitation(
    "accept-wins@example.com",
    "manager",
    new Date(Date.now() + 60_000),
    "clerk-accept-wins",
  );
  emailAddressesByUser.set(userId, [
    {
      emailAddress: "accept-wins@example.com",
      verification: { status: "verified" },
    },
  ]);
  const invitationLocked = deferred();
  const finishAcceptance = deferred();
  const acceptance = acceptPendingFacilityInvitation(userId, {
    ...invitationAcceptanceDependencies,
    afterInvitationLocked: async () => {
      invitationLocked.resolve();
      await finishAcceptance.promise;
    },
  });

  await invitationLocked.promise;
  const cancellation = cancelPendingFacilityInvitation(
    facilityId,
    invitationId,
    {
      database: db,
      revokeInvitation: async () => {},
      resolveUntrackedInvitation: async () => ({ kind: "not-found" }),
    },
  );
  await waitForInvitationLockWait();
  finishAcceptance.resolve();

  assert.equal((await acceptance)?.role, "manager");
  assert.equal(await cancellation, "not-found");
  assert.equal(await db.$count(facilityMembersTable), 1);
  assert.equal(await db.$count(facilityInvitationsTable), 0);
});
