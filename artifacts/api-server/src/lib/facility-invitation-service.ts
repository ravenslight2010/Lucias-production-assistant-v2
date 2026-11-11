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

export type FacilityInvitationForRecovery = {
  id: string;
  email: string;
  createdAt: Date;
};

export type ClerkInvitationForRecovery = {
  id: string;
  emailAddress: string;
  publicMetadata?: Record<string, unknown> | null;
  createdAt: number;
};

const LEGACY_INVITATION_MATCH_WINDOW_MS = 10 * 60 * 1000;
export const FACILITY_INVITATION_METADATA_KEY = "facilityInvitationRecordId";

export function resolveUntrackedClerkInvitation(
  invitation: FacilityInvitationForRecovery,
  clerkInvitations: ClerkInvitationForRecovery[],
): { kind: "matched"; invitationId: string } | { kind: "not-found" | "unsafe" } {
  const normalizedEmail = invitation.email.trim().toLowerCase();
  const emailMatches = clerkInvitations.filter(
    (candidate) =>
      candidate.emailAddress.trim().toLowerCase() === normalizedEmail,
  );
  if (emailMatches.length === 0) return { kind: "not-found" };

  const metadataMatches = emailMatches.filter(
    (candidate) =>
      candidate.publicMetadata?.[FACILITY_INVITATION_METADATA_KEY] ===
      invitation.id,
  );
  if (metadataMatches.length === 1) {
    return { kind: "matched", invitationId: metadataMatches[0].id };
  }
  if (metadataMatches.length > 1) return { kind: "unsafe" };

  const legacyMatches = emailMatches.filter((candidate) => {
    const linkedRecordId =
      candidate.publicMetadata?.[FACILITY_INVITATION_METADATA_KEY];
    return (
      linkedRecordId === undefined &&
      Math.abs(candidate.createdAt - invitation.createdAt.getTime()) <=
        LEGACY_INVITATION_MATCH_WINDOW_MS
    );
  });
  if (legacyMatches.length === 1) {
    return { kind: "matched", invitationId: legacyMatches[0].id };
  }
  return { kind: "unsafe" };
}

export async function persistInvitationTrackingOrCleanup(dependencies: {
  persist(): Promise<boolean>;
  revoke(): Promise<void>;
  removeLocalRecord(): Promise<void>;
}): Promise<"tracked" | "cleaned" | "recovery-required"> {
  try {
    if (await dependencies.persist()) return "tracked";
  } catch {
    // Revoke the Clerk invitation if its ID could not be stored locally.
  }

  try {
    await dependencies.revoke();
    await dependencies.removeLocalRecord();
    return "cleaned";
  } catch {
    return "recovery-required";
  }
}

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
  resolveUntrackedInvitation(
    invitation: FacilityInvitationForRecovery,
  ): Promise<
    { kind: "matched"; invitationId: string } | { kind: "not-found" | "unsafe" }
  >;
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
        email: facilityInvitationsTable.email,
        createdAt: facilityInvitationsTable.createdAt,
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
    if (invitation.clerkInvitationId) {
      await dependencies.revokeInvitation(invitation.clerkInvitationId);
    } else {
      const match = await dependencies.resolveUntrackedInvitation(invitation);
      if (match.kind === "unsafe") return "unresolved" as const;
      if (match.kind === "matched") {
        await dependencies.revokeInvitation(match.invitationId);
      }
    }

    await tx
      .delete(facilityInvitationsTable)
      .where(eq(facilityInvitationsTable.id, invitation.id));
    return "cancelled" as const;
  });
}
