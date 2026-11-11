import { and, eq, gt, inArray } from "drizzle-orm";
import { clerkClient } from "@clerk/express";
import {
  db,
  facilitiesTable,
  facilityInvitationsTable,
  facilityMembersTable,
} from "@workspace/db";
import { getFacilityMembership } from "./run-permissions";

type InvitationEmailAddress = {
  emailAddress: string;
  verification?: { status?: string } | null;
};

type InvitationAcceptanceDependencies = {
  database: typeof db;
  getEmailAddresses(userId: string): Promise<InvitationEmailAddress[]>;
  getMembership: typeof getFacilityMembership;
  afterInvitationLocked?(): Promise<void>;
};

const defaultDependencies: InvitationAcceptanceDependencies = {
  database: db,
  getEmailAddresses: async (userId) =>
    (await clerkClient.users.getUser(userId)).emailAddresses,
  getMembership: getFacilityMembership,
};

type InvitationCancellationDependencies = {
  database: typeof db;
  revokeInvitation(invitationId: string): Promise<void>;
};

export async function acceptPendingFacilityInvitation(
  userId: string,
  dependencies: InvitationAcceptanceDependencies = defaultDependencies,
) {
  const now = new Date();
  const [hasPendingInvitations] = await dependencies.database
    .select({ id: facilityInvitationsTable.id })
    .from(facilityInvitationsTable)
    .where(gt(facilityInvitationsTable.expiresAt, now))
    .limit(1);
  if (!hasPendingInvitations) return null;

  const emailAddresses = await dependencies.getEmailAddresses(userId);
  const verifiedEmails = emailAddresses
    .filter((address) => address.verification?.status === "verified")
    .map((address) => address.emailAddress.trim().toLowerCase());
  if (verifiedEmails.length === 0) return null;

  await dependencies.database.transaction(async (tx) => {
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
    await dependencies.afterInvitationLocked?.();

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

  return dependencies.getMembership(userId);
}

export async function cancelPendingFacilityInvitation(
  facilityId: string,
  invitationId: string,
  dependencies: InvitationCancellationDependencies,
) {
  return dependencies.database.transaction(async (tx) => {
    const [invitation] = await tx
      .select({
        id: facilityInvitationsTable.id,
        clerkInvitationId: facilityInvitationsTable.clerkInvitationId,
      })
      .from(facilityInvitationsTable)
      .where(
        and(
          eq(facilityInvitationsTable.id, invitationId),
          eq(facilityInvitationsTable.facilityId, facilityId),
          gt(facilityInvitationsTable.expiresAt, new Date()),
        ),
      )
      .limit(1)
      .for("update");

    if (!invitation) return "not-found" as const;
    if (!invitation.clerkInvitationId) return "untracked" as const;

    await dependencies.revokeInvitation(invitation.clerkInvitationId);
    await tx
      .delete(facilityInvitationsTable)
      .where(eq(facilityInvitationsTable.id, invitation.id));
    return "cancelled" as const;
  });
}
