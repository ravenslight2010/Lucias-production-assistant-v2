import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
  db,
  facilitiesTable,
  facilityInvitationsTable,
  facilityMembersTable,
} from "@workspace/db";
import { acceptPendingFacilityInvitation } from "../src/lib/facility-invitation-service";
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

async function createInvitation(email: string, role: "manager" | "operator", expiresAt = new Date(Date.now() + 60_000)) {
  await db.insert(facilityInvitationsTable).values({
    facilityId,
    email,
    role,
    invitedBy: "facility-owner",
    expiresAt,
  });
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
