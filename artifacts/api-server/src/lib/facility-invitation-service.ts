import { and, eq, gt, inArray } from "drizzle-orm";
import { clerkClient } from "@clerk/express";
import {
  db,
  facilitiesTable,
  facilityInvitationsTable,
  facilityMembersTable,
} from "@workspace/db";
import { getFacilityMembership } from "./run-permissions";

export async function acceptPendingFacilityInvitation(userId: string) {
  const now = new Date();
  const [hasPendingInvitations] = await db
    .select({ id: facilityInvitationsTable.id })
    .from(facilityInvitationsTable)
    .where(gt(facilityInvitationsTable.expiresAt, now))
    .limit(1);
  if (!hasPendingInvitations) return null;

  const user = await clerkClient.users.getUser(userId);
  const verifiedEmails = user.emailAddresses
    .filter((address) => address.verification?.status === "verified")
    .map((address) => address.emailAddress.trim().toLowerCase());
  if (verifiedEmails.length === 0) return null;

  await db.transaction(async (tx) => {
    const [invitation] = await tx
      .select()
      .from(facilityInvitationsTable)
      .where(
        and(
          gt(facilityInvitationsTable.expiresAt, now),
          inArray(facilityInvitationsTable.email, verifiedEmails),
        ),
      )
      .limit(1)
      .for("update");
    if (!invitation) return;

    const [existingMembership] = await tx
      .select({ id: facilityMembersTable.id })
      .from(facilityMembersTable)
      .where(eq(facilityMembersTable.userId, userId))
      .limit(1);
    if (existingMembership) return;

    const [facility] = await tx
      .select({ id: facilitiesTable.id })
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, invitation.facilityId))
      .limit(1);
    if (!facility) {
      await tx
        .delete(facilityInvitationsTable)
        .where(eq(facilityInvitationsTable.id, invitation.id));
      return;
    }

    const [membership] = await tx
      .insert(facilityMembersTable)
      .values({
        facilityId: invitation.facilityId,
        userId,
        role: invitation.role,
      })
      .onConflictDoNothing()
      .returning({ id: facilityMembersTable.id });
    if (membership) {
      await tx
        .delete(facilityInvitationsTable)
        .where(eq(facilityInvitationsTable.id, invitation.id));
    }
  });

  return getFacilityMembership(userId);
}
