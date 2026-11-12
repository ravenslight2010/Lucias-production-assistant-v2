import { and, count, desc, eq, gt, inArray, isNull, lte, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { doughImportSelectionIdentity } from "../lib/dough-import-selection";
import { cheeseImportSelectionIdentity } from "../lib/cheese-import-selection";
import { sauceImportReviewIdentity } from "../lib/sauce-import-review";
import { premixImportReviewIdentity } from "../lib/premix-import-review";
import { Router, type IRouter, type Request, type Response } from "express";
import { clerkClient } from "@clerk/express";
import {
  ApplyRunCommandBody,
  ApplyRunCommandParams,
  ApplyRunCommandResponse,
  CancelFacilityInvitationParams,
  CreateFacilityBody,
  CreateFacilityResponse,
  CreateV2SessionResponse,
  CreateRunBody,
  CreateRunResponse,
  PreviewRunRequirementsBody,
  PreviewRunRequirementsResponse,
  GetNameLibraryResponse,
  ChangeLibraryNameBody,
  ChangeLibraryNameResponse,
  ImportScheduleBody,
  ImportScheduleResponse,
  GetDashboardSummaryResponse,
  GetFacilityStationsResponse,
  GetFacilityContextResponse,
  GetRunParams,
  GetRunResponse,
  GetRunStationProgressParams,
  GetRunStationProgressResponse,
  UpdateRunStationProgressParams,
  UpdateRunStationProgressBody,
  UpdateRunStationProgressResponse,
  InviteFacilityMemberBody,
  InviteFacilityMemberResponse,
  ImportProductProfileBody,
  ImportProductProfileResponse,
  ListProductProfilesResponse,
  ListImportBatchesResponse,
  MergeProductProfileBody,
  MergeProductProfileParams,
  MergeProductProfileResponse,
  ListFacilityMembersResponse,
  ListRunsQueryParams,
  ListRunsResponse,
  RemoveFacilityMemberParams,
  UpdateFacilityStationsBody,
  UpdateFacilityStationsResponse,
  UpdateFacilityMemberBody,
  UpdateFacilityMemberParams,
  UpdateFacilityMemberResponse,
  RenameProductProfileBody,
  RenameProductProfileParams,
  RenameProductProfileResponse,
} from "@workspace/api-zod";
import {
  db,
  facilityImportBatchesTable,
  facilityInvitationsTable,
  facilitiesTable,
  facilityMembersTable,
  facilityProductProfilesTable,
  facilityStationLayoutsTable,
  productionRunsTable,
} from "@workspace/db";
import { getActorId, requireAuth } from "../middlewares/auth";
import {
  csrfProtection,
  mutationRateLimit,
} from "../middlewares/requestGuards";
import { HttpError } from "../lib/http-error";
import {
  acceptPendingFacilityInvitation,
  cancelPendingFacilityInvitation,
  FACILITY_INVITATION_METADATA_KEY,
  persistInvitationTrackingOrCleanup,
  resolveUntrackedClerkInvitation,
} from "../lib/facility-invitation-service";
import { executeRunCommand } from "../lib/run-command-service";
import {
  getRunStationProgress,
  updateRunStationProgress,
} from "../lib/run-station-progress-service";
import { createPlannedRun } from "../lib/run-create-service";
import { buildRunRequirements } from "../lib/run-requirements";
import { importSchedule } from "../lib/schedule-import-service";
import {
  activeProfile, listProfileNames, lockProfileNames, mergeProfiles, normalizedProfileKey,
  profileForImportedName, profileSourceEntries, renameProfile, safeProfilePayload as safeJsonPayload,
} from "../lib/profile-names";
import { changeLibraryName, getNameLibrary } from "../lib/name-library";
import { loadNameResolution, resolvedProduct } from "../lib/name-resolution";
import { shippingDataMatchesBrand, shippingSelectionIdentity } from "../lib/shipping-import-validation";
import { toContractRun } from "../lib/run-contract";
import {
  DEFAULT_FACILITY_STATIONS,
  FacilityStationLayoutError,
  normalizeFacilityStations,
} from "../lib/facility-stations";
import {
  assertRunPermission,
  getFacilityMembership,
} from "../lib/run-permissions";
import {
  clearV2SessionCookie,
  currentClerkIdentity,
  issueV2Session,
  requireV2Csrf,
  requireV2Session,
  setV2SessionCookie,
} from "../lib/v2-session";

const maxTargetCases = 2_147_483_647;
const router: IRouter = Router();

router.use(requireAuth);

function facilityShape(
  membership: NonNullable<Awaited<ReturnType<typeof getFacilityMembership>>>,
) {
  return {
    facility: {
      id: membership.facilityId,
      name: membership.facilityName,
      createdAt: membership.facilityCreatedAt,
    },
    role: membership.role,
  };
}

function actorOrRespond(req: Request, res: Response) {
  const actorId = getActorId(req);
  if (!actorId) {
    res.status(401).json({ error: "Sign in to continue." });
    return null;
  }
  return actorId;
}

async function membershipOrRespond(
  req: Request,
  res: Response,
) {
  const actorId = actorOrRespond(req, res);
  if (!actorId) return null;
  const membership =
    (await getFacilityMembership(actorId)) ??
    (await acceptPendingFacilityInvitation(actorId));
  if (!membership) {
    res.status(403).json({ error: "Set up a facility before continuing." });
    return null;
  }
  return { actorId, membership };
}

async function ownerAccessOrRespond(req: Request, res: Response) {
  const access = await membershipOrRespond(req, res);
  if (!access) return null;
  if (access.membership.role !== "owner") {
    res.status(403).json({ error: "Only facility owners can manage members." });
    return null;
  }
  return access;
}

async function stationManagerAccessOrRespond(req: Request, res: Response) {
  const access = await membershipOrRespond(req, res);
  if (!access) return null;
  if (
    access.membership.role !== "owner" &&
    access.membership.role !== "manager"
  ) {
    res.status(403).json({ error: "Only owners and managers can edit stations." });
    return null;
  }
  return access;
}

async function ensureFacilityStationLayout(facilityId: string) {
  await db
    .insert(facilityStationLayoutsTable)
    .values({
      facilityId,
      revision: 0,
      stations: DEFAULT_FACILITY_STATIONS,
    })
    .onConflictDoNothing();

  const [layout] = await db
    .select()
    .from(facilityStationLayoutsTable)
    .where(eq(facilityStationLayoutsTable.facilityId, facilityId))
    .limit(1);
  if (!layout) {
    throw new Error("Facility station layout could not be initialized.");
  }
  return layout;
}

function hasPostgresCode(error: unknown, code: string) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function userEmail(user: {
  primaryEmailAddress?: { emailAddress: string } | null;
  emailAddresses: Array<{ emailAddress: string }>;
}) {
  return (
    user.primaryEmailAddress?.emailAddress ??
    user.emailAddresses[0]?.emailAddress ??
    null
  );
}

async function revokeClerkInvitation(invitationId: string): Promise<void> {
  try {
    await clerkClient.invitations.revokeInvitation(invitationId);
  } catch (revokeError) {
    try {
      const revokedInvitations = await clerkClient.invitations.getInvitationList({
        query: invitationId,
        status: "revoked",
        limit: 100,
      });
      if (revokedInvitations.data.some((invitation) => invitation.id === invitationId)) {
        return;
      }
    } catch {
      // Preserve the original revocation error if Clerk cannot confirm the status.
    }
    throw revokeError;
  }
}

router.get("/facility/context", async (req, res): Promise<void> => {
  const actorId = actorOrRespond(req, res);
  if (!actorId) return;
  const membership =
    (await getFacilityMembership(actorId)) ??
    (await acceptPendingFacilityInvitation(actorId));
  const response = membership
    ? facilityShape(membership)
    : { facility: null, role: null };
  res.json(GetFacilityContextResponse.parse(response));
});

router.post(
  "/v2/run-requirements/preview",
  requireV2Session,
  requireV2Csrf,
  mutationRateLimit,
  async (req, res): Promise<void> => {
    const access = await membershipOrRespond(req, res);
    if (!access) return;
    const parsed = PreviewRunRequirementsBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Choose a product, a supported whole case count, and valid source-based planning choices." }); return; }
    const input = parsed.data;
    const plan = await db.transaction(async (tx) => {
      await lockProfileNames(tx, access.membership.facilityId);
      const [profile] = await tx.select().from(facilityProductProfilesTable).where(and(
        eq(facilityProductProfilesTable.facilityId, access.membership.facilityId),
        eq(facilityProductProfilesTable.id, input.productProfileId),
        isNull(facilityProductProfilesTable.mergedIntoId),
      )).limit(1);
      if (!profile) throw new HttpError(404, "The selected product profile is no longer available.");
      const resolution = await loadNameResolution(tx, access.membership.facilityId);
      if (input.review && (profile.revision !== input.review.expectedProfileRevision || resolution.revision !== input.review.expectedNameRevision)) {
        throw new HttpError(409, "The product or remembered names changed. Refresh and review the requirements again.");
      }
      return buildRunRequirements({ ...profile, nameResolution: resolution }, input.targetCases, input.review?.options);
    });
    res.json(PreviewRunRequirementsResponse.parse(plan));
  },
);

router.post(
  "/v2/session",
  csrfProtection,
  mutationRateLimit,
  async (req, res): Promise<void> => {
    const identity = currentClerkIdentity(req);
    const issued = issueV2Session(identity.actorId, identity.sessionId);
    setV2SessionCookie(res, issued.token, issued.maxAgeSeconds);
    res.json(CreateV2SessionResponse.parse({ csrfToken: issued.csrfToken }));
  },
);

router.delete(
  "/v2/session",
  requireV2Session,
  requireV2Csrf,
  mutationRateLimit,
  (_req, res): void => {
    clearV2SessionCookie(res);
    res.sendStatus(204);
  },
);

router.post(
  "/facilities",
  requireV2Session,
  requireV2Csrf,
  mutationRateLimit,
  async (req, res): Promise<void> => {
    const actorId = actorOrRespond(req, res);
    if (!actorId) return;
    const parsed = CreateFacilityBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Enter a facility name up to 120 characters." });
      return;
    }
    const name = parsed.data.name.trim();
    if (!name) {
      res.status(400).json({ error: "Facility name cannot be blank." });
      return;
    }

    try {
      const context = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: facilityMembersTable.id })
          .from(facilityMembersTable)
          .where(eq(facilityMembersTable.userId, actorId))
          .limit(1);
        if (existing) throw new HttpError(409, "Facility setup is already complete.");

        const [facility] = await tx
          .insert(facilitiesTable)
          .values({ name })
          .returning();
        await tx.insert(facilityMembersTable).values({
          facilityId: facility.id,
          userId: actorId,
          role: "owner",
        });
        return { facility, role: "owner" as const };
      });
      res.status(201).json(CreateFacilityResponse.parse(context));
    } catch (error) {
      if (
        error instanceof HttpError ||
        (typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "23505")
      ) {
        res.status(409).json({ error: "Facility setup is already complete." });
        return;
      }
      throw error;
    }
  },
);

router.get(
  "/facility/members",
  requireV2Session,
  async (req, res): Promise<void> => {
    const access = await ownerAccessOrRespond(req, res);
    if (!access) return;
    const now = new Date();

    await db
      .delete(facilityInvitationsTable)
      .where(
        and(
          eq(facilityInvitationsTable.facilityId, access.membership.facilityId),
          lte(facilityInvitationsTable.expiresAt, now),
        ),
      );

    const [members, pendingInvitations] = await Promise.all([
      db
        .select()
        .from(facilityMembersTable)
        .where(eq(facilityMembersTable.facilityId, access.membership.facilityId)),
      db
        .select({
          id: facilityInvitationsTable.id,
          email: facilityInvitationsTable.email,
          role: facilityInvitationsTable.role,
          createdAt: facilityInvitationsTable.createdAt,
          expiresAt: facilityInvitationsTable.expiresAt,
        })
        .from(facilityInvitationsTable)
        .where(
          and(
            eq(facilityInvitationsTable.facilityId, access.membership.facilityId),
            gt(facilityInvitationsTable.expiresAt, now),
          ),
        ),
    ]);

    const userIds = members.map((member) => member.userId);
    const users = (
      await Promise.all(
        Array.from({ length: Math.ceil(userIds.length / 100) }, (_, index) =>
          clerkClient.users.getUserList({
            userId: userIds.slice(index * 100, (index + 1) * 100),
            limit: 100,
          }),
        ),
      )
    ).flatMap((page) => page.data);
    const emailByUserId = new Map(
      users.map((user) => [user.id, userEmail(user)]),
    );

    res.json(
      ListFacilityMembersResponse.parse({
        members: members.map((member) => ({
          id: member.id,
          email: emailByUserId.get(member.userId) ?? null,
          role: member.role,
        })),
        pendingInvitations,
      }),
    );
  },
);

router.post(
  "/facility/members",
  requireV2Session,
  requireV2Csrf,
  mutationRateLimit,
  async (req, res): Promise<void> => {
    const access = await ownerAccessOrRespond(req, res);
    if (!access) return;
    const parsed = InviteFacilityMemberBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Enter a valid email and choose a manager or operator role." });
      return;
    }

    const email = parsed.data.email.trim().toLowerCase();
    const existingUsers = await clerkClient.users.getUserList({
      emailAddress: [email],
      limit: 1,
    });
    const existingUser = existingUsers.data.find((user) =>
      user.emailAddresses.some(
        (address) => address.emailAddress.trim().toLowerCase() === email,
      ),
    );

    if (existingUser) {
      const verifiedEmail = existingUser.emailAddresses.some(
        (address) =>
          address.emailAddress.trim().toLowerCase() === email &&
          address.verification?.status === "verified",
      );
      if (!verifiedEmail) {
        res.status(409).json({
          error: "That account must verify this email before it can be added.",
        });
        return;
      }
      const [existingMembership] = await db
        .select({ id: facilityMembersTable.id })
        .from(facilityMembersTable)
        .where(eq(facilityMembersTable.userId, existingUser.id))
        .limit(1);
      if (existingMembership) {
        res.status(409).json({ error: "That account already belongs to a facility." });
        return;
      }
      try {
        await db.insert(facilityMembersTable).values({
          facilityId: access.membership.facilityId,
          userId: existingUser.id,
          role: parsed.data.role,
        });
      } catch (error) {
        if (hasPostgresCode(error, "23505")) {
          res.status(409).json({ error: "That account already belongs to a facility." });
          return;
        }
        throw error;
      }

      res.status(201).json(
        InviteFacilityMemberResponse.parse({
          email,
          role: parsed.data.role,
          status: "added",
        }),
      );
      return;
    }

    const now = new Date();
    await db
      .delete(facilityInvitationsTable)
      .where(
        and(
          eq(facilityInvitationsTable.email, email),
          lte(facilityInvitationsTable.expiresAt, now),
        ),
      );
    const [existingInvitation] = await db
      .select({ id: facilityInvitationsTable.id })
      .from(facilityInvitationsTable)
      .where(eq(facilityInvitationsTable.email, email))
      .limit(1);
    if (existingInvitation) {
      res.status(409).json({ error: "An invitation for that email is already pending." });
      return;
    }

    const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    let pendingInvitation: { id: string };
    try {
      const [inserted] = await db
        .insert(facilityInvitationsTable)
        .values({
          facilityId: access.membership.facilityId,
          email,
          role: parsed.data.role,
          invitedBy: access.actorId,
          expiresAt,
        })
        .returning({ id: facilityInvitationsTable.id });
      pendingInvitation = inserted;
    } catch (error) {
      if (hasPostgresCode(error, "23505")) {
        res.status(409).json({ error: "An invitation for that email is already pending." });
        return;
      }
      throw error;
    }

    const origin = req.get("origin");
    if (!origin) {
      await db
        .delete(facilityInvitationsTable)
        .where(eq(facilityInvitationsTable.id, pendingInvitation.id));
      res.status(403).json({ error: "Request origin could not be verified." });
      return;
    }
    let clerkInvitation: Awaited<
      ReturnType<typeof clerkClient.invitations.createInvitation>
    >;
    try {
      clerkInvitation = await clerkClient.invitations.createInvitation({
        emailAddress: email,
        expiresInDays: 30,
        ignoreExisting: true,
        publicMetadata: {
          [FACILITY_INVITATION_METADATA_KEY]: pendingInvitation.id,
        },
        redirectUrl: new URL("/sign-up", origin).toString(),
      });
    } catch (error) {
      await db
        .delete(facilityInvitationsTable)
        .where(eq(facilityInvitationsTable.id, pendingInvitation.id));
      const status =
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        typeof error.status === "number"
          ? error.status
          : undefined;
      req.log.warn({ status }, "Clerk invitation could not be created");
      res
        .status(status && status < 500 ? 409 : 502)
        .json({ error: "The email invitation could not be sent. Please try again." });
      return;
    }
    const trackingResult = await persistInvitationTrackingOrCleanup({
      persist: async () => {
        const [updatedInvitation] = await db
          .update(facilityInvitationsTable)
          .set({ clerkInvitationId: clerkInvitation.id })
          .where(eq(facilityInvitationsTable.id, pendingInvitation.id))
          .returning({ id: facilityInvitationsTable.id });
        return Boolean(updatedInvitation);
      },
      revoke: () => revokeClerkInvitation(clerkInvitation.id),
      removeLocalRecord: async () => {
        await db
          .delete(facilityInvitationsTable)
          .where(eq(facilityInvitationsTable.id, pendingInvitation.id));
      },
    });
    if (trackingResult !== "tracked") {
      req.log.warn(
        { invitationRecordId: pendingInvitation.id, trackingResult },
        "Clerk invitation tracking failed and compensation did not fully complete",
      );
      res.status(502).json({
        error:
          trackingResult === "cleaned"
            ? "The invitation could not be tracked and was cancelled. You can invite this email again now."
            : "The invitation could not be tracked or cancelled. Cancel the pending invitation before inviting this email again.",
      });
      return;
    }

    res.status(201).json(
      InviteFacilityMemberResponse.parse({
        email,
        role: parsed.data.role,
        status: "invited",
      }),
    );
  },
);

router.delete(
  "/facility/invitations/:invitationId",
  requireV2Session,
  requireV2Csrf,
  mutationRateLimit,
  async (req, res): Promise<void> => {
    const access = await ownerAccessOrRespond(req, res);
    if (!access) return;
    const params = CancelFacilityInvitationParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid facility invitation." });
      return;
    }

    const result = await cancelPendingFacilityInvitation(
      access.membership.facilityId,
      params.data.invitationId,
      {
        database: db,
        revokeInvitation: async (clerkInvitationId) => {
          try {
            await revokeClerkInvitation(clerkInvitationId);
          } catch {
            req.log.warn(
              { invitationId: params.data.invitationId },
              "Clerk invitation could not be revoked",
            );
            throw new HttpError(
              502,
              "The invitation could not be cancelled. Please try again.",
            );
          }
        },
        resolveUntrackedInvitation: async (invitation) => {
          try {
            const response = await clerkClient.invitations.getInvitationList({
              query: invitation.email,
              status: "pending",
              limit: 100,
            });
            return resolveUntrackedClerkInvitation(
              invitation,
              response.data,
            );
          } catch {
            req.log.warn(
              { invitationId: invitation.id },
              "Clerk invitations could not be checked during recovery",
            );
            throw new HttpError(
              502,
              "The invitation could not be recovered. Please try again.",
            );
          }
        },
      },
    );

    if (result === "not-found") {
      res.status(404).json({ error: "Pending facility invitation not found." });
      return;
    }
    if (result === "unresolved") {
      res.status(409).json({
        error:
          "This invitation could not be safely matched to a Clerk record. It was not changed; contact support before retrying.",
      });
      return;
    }

    res.sendStatus(204);
  },
);

router.patch(
  "/facility/members/:memberId",
  requireV2Session,
  requireV2Csrf,
  mutationRateLimit,
  async (req, res): Promise<void> => {
    const access = await ownerAccessOrRespond(req, res);
    if (!access) return;
    const params = UpdateFacilityMemberParams.safeParse(req.params);
    const body = UpdateFacilityMemberBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Choose a manager or operator role." });
      return;
    }

    const [target] = await db
      .select({ id: facilityMembersTable.id, role: facilityMembersTable.role })
      .from(facilityMembersTable)
      .where(
        and(
          eq(facilityMembersTable.id, params.data.memberId),
          eq(facilityMembersTable.facilityId, access.membership.facilityId),
        ),
      )
      .limit(1);
    if (!target) {
      res.status(404).json({ error: "Facility member not found." });
      return;
    }
    if (target.role === "owner") {
      res.status(403).json({ error: "Owner roles cannot be changed here." });
      return;
    }

    const [updated] = await db
      .update(facilityMembersTable)
      .set({ role: body.data.role })
      .where(eq(facilityMembersTable.id, target.id))
      .returning({ id: facilityMembersTable.id });
    if (!updated) {
      res.status(404).json({ error: "Facility member not found." });
      return;
    }

    res.json(
      UpdateFacilityMemberResponse.parse({
        id: updated.id,
        email: null,
        role: body.data.role,
      }),
    );
  },
);

router.delete(
  "/facility/members/:memberId",
  requireV2Session,
  requireV2Csrf,
  mutationRateLimit,
  async (req, res): Promise<void> => {
    const access = await ownerAccessOrRespond(req, res);
    if (!access) return;
    const params = RemoveFacilityMemberParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid facility member." });
      return;
    }

    const [target] = await db
      .select({ id: facilityMembersTable.id, role: facilityMembersTable.role })
      .from(facilityMembersTable)
      .where(
        and(
          eq(facilityMembersTable.id, params.data.memberId),
          eq(facilityMembersTable.facilityId, access.membership.facilityId),
        ),
      )
      .limit(1);
    if (!target) {
      res.status(404).json({ error: "Facility member not found." });
      return;
    }
    if (target.role === "owner") {
      res.status(403).json({ error: "Owners cannot be removed from the facility." });
      return;
    }

    await db
      .delete(facilityMembersTable)
      .where(eq(facilityMembersTable.id, target.id));
    res.sendStatus(204);
  },
);

router.get(
  "/facility/stations",
  requireV2Session,
  async (req, res): Promise<void> => {
    const access = await membershipOrRespond(req, res);
    if (!access) return;
    const layout = await ensureFacilityStationLayout(
      access.membership.facilityId,
    );
    res.json(
      GetFacilityStationsResponse.parse({
        revision: layout.revision,
        stations: layout.stations,
      }),
    );
  },
);

router.put(
  "/facility/stations",
  requireV2Session,
  requireV2Csrf,
  mutationRateLimit,
  async (req, res): Promise<void> => {
    const parsed = UpdateFacilityStationsBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Check the station names and lineup." });
      return;
    }
    const access = await stationManagerAccessOrRespond(req, res);
    if (!access) return;

    const facilityId = access.membership.facilityId;
    await ensureFacilityStationLayout(facilityId);
    const result = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(facilityStationLayoutsTable)
        .where(eq(facilityStationLayoutsTable.facilityId, facilityId))
        .for("update")
        .limit(1);
      if (!current) {
        return { type: "missing" as const };
      }
      if (current.revision !== parsed.data.expectedRevision) {
        return { type: "conflict" as const, layout: current };
      }

      let stations;
      try {
        stations = normalizeFacilityStations(
          current.stations,
          parsed.data.stations,
        );
      } catch (error) {
        if (error instanceof FacilityStationLayoutError) {
          return { type: "invalid" as const, message: error.message };
        }
        throw error;
      }

      const [updated] = await tx
        .update(facilityStationLayoutsTable)
        .set({
          stations,
          revision: current.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(facilityStationLayoutsTable.facilityId, facilityId))
        .returning();
      if (!updated) {
        return { type: "missing" as const };
      }
      return { type: "updated" as const, layout: updated };
    });

    if (result.type === "missing") {
      res.status(404).json({ error: "Facility station lineup not found." });
      return;
    }
    if (result.type === "invalid") {
      res.status(400).json({ error: result.message });
      return;
    }
    if (result.type === "conflict") {
      res.status(409).json({
        error: "This lineup changed on another device. Refresh and try again.",
        current: GetFacilityStationsResponse.parse({
          revision: result.layout.revision,
          stations: result.layout.stations,
        }),
      });
      return;
    }
    res.json(
      UpdateFacilityStationsResponse.parse({
        revision: result.layout.revision,
        stations: result.layout.stations,
      }),
    );
  },
);

router.get("/v2/name-library", requireV2Session, async (req, res): Promise<void> => {
  const access = await membershipOrRespond(req, res);
  if (!access) return;
  res.json(GetNameLibraryResponse.parse(await getNameLibrary(access.membership.facilityId)));
});

router.patch("/v2/name-library", requireV2Session, requireV2Csrf, mutationRateLimit, async (req, res): Promise<void> => {
  const parsed = ChangeLibraryNameBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Review the name, brand, and selected destination." }); return; }
  const access = await membershipOrRespond(req, res);
  if (!access) return;
  assertRunPermission(access.membership.role, "create");
  const result = await changeLibraryName({ ...parsed.data, facilityId: access.membership.facilityId });
  req.log.info({ facilityId: access.membership.facilityId, operation: parsed.data.operation, kind: parsed.data.source.kind,
    revision: result.resolution.revision }, "Facility name library changed");
  res.json(ChangeLibraryNameResponse.parse(result));
});

router.get("/v2/product-profiles", requireV2Session, async (req, res): Promise<void> => {
  const access = await membershipOrRespond(req, res);
  if (!access) return;
  res.json(ListProductProfilesResponse.parse(await listProfileNames(access.membership.facilityId)));
});

router.get("/v2/import-batches", requireV2Session, async (req, res): Promise<void> => {
  const access = await membershipOrRespond(req, res);
  if (!access) return;
  const rows = await db
    .select({
      id: facilityImportBatchesTable.id,
      sourceName: facilityImportBatchesTable.sourceName,
      importKind: facilityImportBatchesTable.importKind,
      status: facilityImportBatchesTable.status,
      proposedBrand: facilityImportBatchesTable.proposedBrand,
      proposedFlavor: facilityImportBatchesTable.proposedFlavor,
      profileId: facilityImportBatchesTable.profileId,
      summary: facilityImportBatchesTable.summary,
      createdAt: facilityImportBatchesTable.createdAt,
      appliedAt: facilityImportBatchesTable.appliedAt,
    })
    .from(facilityImportBatchesTable)
    .where(eq(facilityImportBatchesTable.facilityId, access.membership.facilityId))
    .orderBy(desc(facilityImportBatchesTable.createdAt))
    .limit(100);
  const imports = rows.map(({ summary, ...row }) => {
    const storedCount = summary && typeof summary === "object" && !Array.isArray(summary)
      ? (summary as Record<string, unknown>).importedCount
      : null;
    return {
      ...row,
      scheduleRunCount: row.importKind === "schedule" &&
        typeof storedCount === "number" && Number.isSafeInteger(storedCount) && storedCount >= 0
        ? storedCount
        : null,
    };
  });
  res.json(ListImportBatchesResponse.parse({ imports }));
});

router.post(
  "/v2/schedule-imports",
  requireV2Session,
  requireV2Csrf,
  mutationRateLimit,
  async (req, res): Promise<void> => {
    const parsed = ImportScheduleBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Review the schedule rows and profile mappings before importing." });
      return;
    }
    const access = await membershipOrRespond(req, res);
    if (!access) return;
    assertRunPermission(access.membership.role, "create");

    const importDate = parsed.data.importDate.toISOString().slice(0, 10);
    const runs = parsed.data.runs.map((run) => ({
      ...run,
      date: run.date.toISOString().slice(0, 10),
    }));
    try {
      const result = await importSchedule({
        ...parsed.data,
        facilityId: access.membership.facilityId,
        actorUserId: access.actorId,
        sourceHash: parsed.data.sourceHash.toLowerCase(),
        importDate,
        runs,
      });
      const response = ImportScheduleResponse.parse(result);
      res.status(response.replayed ? 200 : 201).json(response);
      req.log.info({
        importId: response.importId,
        importedCount: response.importedCount,
        ignoredPastCount: response.ignoredPastCount,
        needsReviewRunCount: response.needsReviewRunCount,
        replayed: response.replayed,
        facilityId: access.membership.facilityId,
      }, "Production schedule import processed");
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      req.log.error({ err: error, facilityId: access.membership.facilityId }, "Production schedule import failed");
      res.status(500).json({ error: "The schedule could not be imported. No partial runs were saved." });
    }
  },
);

router.post(
  "/v2/product-profiles",
  requireV2Session,
  requireV2Csrf,
  mutationRateLimit,
  async (req, res): Promise<void> => {
    const parsed = ImportProductProfileBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Review the workbook details and try again." });
      return;
    }
    const input = parsed.data;
    const brand = input.brand.normalize("NFKC").trim().replace(/\s+/g, " ");
    const flavor = input.flavor.normalize("NFKC").trim().replace(/\s+/g, " ");
    const sourceName = input.sourceName.trim();
    if (
      !brand ||
      !flavor ||
      /[/\\\u0000-\u001f]/.test(sourceName) ||
      !/^[a-f0-9]{64}$/i.test(input.sourceHash) ||
      input.importKind === "schedule" ||
      !safeJsonPayload(input.productData) ||
      (input.importKind === "shipping" && !shippingDataMatchesBrand(input.productData, brand, flavor))
    ) {
      res.status(400).json({
        error: input.importKind === "shipping"
          ? "Review one shipping variant for the target product, or supply legacy rows for only its brand."
          : "This workbook cannot be saved as product setup data.",
      });
      return;
    }
    const access = await membershipOrRespond(req, res);
    if (!access) return;
    assertRunPermission(access.membership.role, "create");
    let doughSelection: string | null = null;
    let cheeseSelection: string | null = null;
    let sauceSelection: string | null = null;
    const shippingSelection = input.importKind === "shipping"
      ? shippingSelectionIdentity(input.productData, brand, flavor)
      : null;
    if (input.importKind === "dough_guide") {
      try {
        doughSelection = doughImportSelectionIdentity(input.productData);
      } catch {
        res.status(400).json({ error: "Review the dough variant, batch column, and source discrepancies before saving." });
        return;
      }
    }
    if (input.importKind === "cheese") {
      try {
        cheeseSelection = cheeseImportSelectionIdentity(input.productData);
      } catch {
        res.status(400).json({ error: "Choose cheese formulas from one customer tab and review source discrepancies before saving." });
        return;
      }
    }
    let premixSelection: string | null = null;
    if (input.importKind === "premix") {
      try {
        premixSelection = premixImportReviewIdentity(input.productData);
      } catch {
        res.status(400).json({ error: "Review the premix source details and save them as reference data before continuing." });
        return;
      }
    }
    if (input.importKind === "sauce_guide") {
      try {
        sauceSelection = sauceImportReviewIdentity(input.productData);
      } catch {
        res.status(400).json({ error: "Review the sauce source discrepancies and save them as reference data before continuing." });
        return;
      }
    }
    const dataHash = createHash("sha256")
      .update(JSON.stringify({
        brand, flavor, kind: input.importKind, sourceHash: input.sourceHash,
        ...(doughSelection ? { doughSelection } : {}),
        ...(cheeseSelection ? { cheeseSelection } : {}),
        ...(sauceSelection ? { sauceSelection } : {}),
        ...(premixSelection ? { premixSelection } : {}),
        ...(shippingSelection ? { shippingSelection } : {}),
      }))
      .digest("hex");
    try {
      const result = await db.transaction(async (tx) => {
        await lockProfileNames(tx, access.membership.facilityId);
        const [previousBatch] = await tx.select().from(facilityImportBatchesTable).where(and(
          eq(facilityImportBatchesTable.facilityId, access.membership.facilityId),
          eq(facilityImportBatchesTable.sourceHash, dataHash),
          eq(facilityImportBatchesTable.status, "applied"),
        )).limit(1);
        if (previousBatch?.profileId) {
          const [previousProfile] = await tx.select().from(facilityProductProfilesTable).where(and(
            eq(facilityProductProfilesTable.id, previousBatch.profileId),
            eq(facilityProductProfilesTable.facilityId, access.membership.facilityId),
          )).limit(1);
          if (previousProfile) return { profile: await activeProfile(tx, access.membership.facilityId, previousProfile.id), batch: previousBatch, imported: false };
        }
        const existing = await profileForImportedName(tx, access.membership.facilityId, brand, flavor);
        if (existing) {
          if (input.expectedRevision === undefined || existing.revision !== input.expectedRevision) {
            throw new HttpError(409, "This brand and flavor already has a profile. Refresh it, then add the workbook to its current revision.");
          }
          const sourceBundle = {
            profileId: existing.id,
            brand,
            flavor,
            importKind: input.importKind,
            sourceName,
            sourceHash: input.sourceHash.toLowerCase(),
            content: input.productData,
          };
          const sources = [...profileSourceEntries(existing), sourceBundle];
          if (!safeJsonPayload({ sources })) {
            throw new HttpError(413, "The combined profile source data exceeds the facility profile limit.");
          }
          const [profile] = await tx
            .update(facilityProductProfilesTable)
            .set({
              productData: { sources },
              revision: sql`${facilityProductProfilesTable.revision} + 1`,
              updatedAt: new Date(),
            })
            .where(and(
              eq(facilityProductProfilesTable.id, existing.id),
              eq(facilityProductProfilesTable.facilityId, access.membership.facilityId),
              eq(facilityProductProfilesTable.revision, input.expectedRevision),
            ))
            .returning();
          if (!profile) {
            throw new HttpError(409, "This profile changed on another device. Refresh and review the latest revision.");
          }
          const [batch] = await tx
            .insert(facilityImportBatchesTable)
            .values({
              facilityId: access.membership.facilityId,
              sourceName,
              sourceHash: dataHash,
              importKind: input.importKind,
              status: "applied",
              proposedBrand: brand,
              proposedFlavor: flavor,
              workbookData: { sourceHash: input.sourceHash.toLowerCase(), profileId: profile.id },
              summary: { profileId: profile.id, addedSource: true, revision: profile.revision },
              profileId: profile.id,
              createdBy: access.actorId,
              appliedAt: new Date(),
            })
            .returning();
          return { profile, batch, imported: true };
        }
        if (input.expectedRevision !== undefined) {
          throw new HttpError(409, "This profile changed on another device. Refresh the profile list before importing.");
        }
        const canonical = resolvedProduct(brand, flavor, (await loadNameResolution(tx, access.membership.facilityId)).rules);
        const [profile] = await tx
          .insert(facilityProductProfilesTable)
          .values({
            facilityId: access.membership.facilityId,
            ...canonical,
            normalizedKey: normalizedProfileKey(canonical.brand, canonical.flavor),
            revision: 0,
            productData: {
              brand,
              flavor,
              importKind: input.importKind,
              sourceName,
              sourceHash: input.sourceHash,
              content: input.productData,
            },
            createdBy: access.actorId,
          })
          .returning();
        const [batch] = await tx
          .insert(facilityImportBatchesTable)
          .values({
            facilityId: access.membership.facilityId,
            sourceName,
            sourceHash: dataHash,
            importKind: input.importKind,
            status: "applied",
            proposedBrand: brand,
            proposedFlavor: flavor,
            workbookData: { sourceHash: input.sourceHash, profileId: profile.id },
            summary: { profileId: profile.id },
            profileId: profile.id,
            createdBy: access.actorId,
            appliedAt: new Date(),
          })
          .returning();
        return { profile, batch, imported: true };
      });
      res.status(201).json(ImportProductProfileResponse.parse({
        profile: result.profile,
        imported: result.imported,
      }));
      req.log.info({ importId: result.batch.id, profileId: result.profile.id, imported: result.imported }, "Product workbook import processed");
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        res.status(409).json({ error: "A profile with this brand and flavor already exists. Review the current profile before retrying." });
        return;
      }
      req.log.error({ err: error }, "Product workbook import failed");
      res.status(500).json({ error: "Workbook could not be imported." });
    }
  },
);

router.patch(
  "/v2/product-profiles/:profileId",
  requireV2Session,
  requireV2Csrf,
  mutationRateLimit,
  async (req, res): Promise<void> => {
    const params = RenameProductProfileParams.safeParse(req.params);
    const body = RenameProductProfileBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({ error: "Enter a valid brand and flavor." });
      return;
    }
    const access = await membershipOrRespond(req, res);
    if (!access) return;
    assertRunPermission(access.membership.role, "create");
    const brand = body.data.brand.normalize("NFKC").trim().replace(/\s+/g, " ");
    const flavor = body.data.flavor.normalize("NFKC").trim().replace(/\s+/g, " ");
    if (!brand || !flavor) {
      res.status(400).json({ error: "Enter a valid brand and flavor." });
      return;
    }
    try {
      const profile = await renameProfile({
        facilityId: access.membership.facilityId, profileId: params.data.profileId,
        brand, flavor, expectedRevision: body.data.expectedRevision,
      });
      res.json(RenameProductProfileResponse.parse({ profile }));
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        res.status(409).json({ error: "A profile with this brand and flavor already exists." });
        return;
      }
      throw error;
    }
  },
);

router.post(
  "/v2/product-profiles/:profileId/merge",
  requireV2Session,
  requireV2Csrf,
  mutationRateLimit,
  async (req, res): Promise<void> => {
    const params = MergeProductProfileParams.safeParse(req.params);
    const body = MergeProductProfileBody.safeParse(req.body);
    if (!params.success || !body.success || params.data.profileId === body.data.targetProfileId) {
      res.status(400).json({ error: "Choose two different product profiles to merge." });
      return;
    }
    const access = await membershipOrRespond(req, res);
    if (!access) return;
    assertRunPermission(access.membership.role, "create");
    const result = await mergeProfiles({
      facilityId: access.membership.facilityId,
      sourceId: params.data.profileId, targetId: body.data.targetProfileId,
      expectedSourceRevision: body.data.expectedSourceRevision,
      expectedTargetRevision: body.data.expectedTargetRevision,
    });
    res.json(MergeProductProfileResponse.parse(result));
    req.log.info({ profileId: result.mergedProfileId, targetProfileId: result.profile.id }, "Product profiles merged");
  },
);

router.get(
  "/v2/runs",
  requireV2Session,
  async (req, res): Promise<void> => {
  const parsed = ListRunsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Choose a run limit between 1 and 100." });
    return;
  }
  const access = await membershipOrRespond(req, res);
  if (!access) return;

  const rows = await db
    .select()
    .from(productionRunsTable)
    .where(eq(productionRunsTable.facilityId, access.membership.facilityId))
    .orderBy(desc(productionRunsTable.updatedAt))
    .limit(parsed.data.limit);

  res.json(ListRunsResponse.parse({ runs: rows.map(toContractRun) }));
});

router.post(
  "/v2/runs",
  requireV2Session,
  requireV2Csrf,
  mutationRateLimit,
  async (req, res): Promise<void> => {
    const parsed = CreateRunBody.safeParse(req.body);
    if (
      !parsed.success ||
      !parsed.data.setupSnapshot.label.trim() ||
      parsed.data.setupSnapshot.targetCases > maxTargetCases
    ) {
      res.status(400).json({ error: "Enter a label and target case count." });
      return;
    }
    const access = await membershipOrRespond(req, res);
    if (!access) return;
    assertRunPermission(access.membership.role, "create");

    const result = await createPlannedRun({
      facilityId: access.membership.facilityId,
      actorUserId: access.actorId,
      requestId: parsed.data.requestId,
      setupSnapshot: {
        ...parsed.data.setupSnapshot,
        productProfileId: parsed.data.setupSnapshot.productProfileId ?? null,
      },
    });
    const response = CreateRunResponse.parse(result);
    res.status(response.replayed ? 200 : 201).json(response);
  },
);

router.get(
  "/v2/runs/:runId",
  requireV2Session,
  async (req, res): Promise<void> => {
  const params = GetRunParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid run identifier." });
    return;
  }
  const access = await membershipOrRespond(req, res);
  if (!access) return;
  const [run] = await db
    .select()
    .from(productionRunsTable)
    .where(
      and(
        eq(productionRunsTable.id, params.data.runId),
        eq(productionRunsTable.facilityId, access.membership.facilityId),
      ),
    )
    .limit(1);
  if (!run) {
    res.status(404).json({ error: "Run not found." });
    return;
  }
  res.json(GetRunResponse.parse({ run: toContractRun(run) }));
});

router.post(
  "/v2/runs/:runId/commands",
  requireV2Session,
  requireV2Csrf,
  mutationRateLimit,
  async (req, res): Promise<void> => {
    const params = ApplyRunCommandParams.safeParse(req.params);
    const command = ApplyRunCommandBody.safeParse(req.body);
    if (!params.success || !command.success) {
      res.status(400).json({ error: "Invalid run command." });
      return;
    }
    const access = await membershipOrRespond(req, res);
    if (!access) return;
    assertRunPermission(access.membership.role, command.data.commandType);

    const result = await executeRunCommand({
      facilityId: access.membership.facilityId,
      actorUserId: access.actorId,
      runId: params.data.runId,
      command: command.data,
    });
    if (result.outcome === "conflict") {
      res.status(409).json(result);
      return;
    }
    if (result.outcome === "invalid_transition") {
      res.status(409).json(result);
      return;
    }
    res.json(ApplyRunCommandResponse.parse(result));
  },
);

router.get(
  "/v2/runs/:runId/stations",
  requireV2Session,
  async (req, res): Promise<void> => {
    const params = GetRunStationProgressParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid run identifier." });
      return;
    }
    const access = await membershipOrRespond(req, res);
    if (!access) return;

    const progress = await getRunStationProgress({
      facilityId: access.membership.facilityId,
      runId: params.data.runId,
    });
    res.json(GetRunStationProgressResponse.parse(progress));
  },
);

router.patch(
  "/v2/runs/:runId/stations/:stationId",
  requireV2Session,
  requireV2Csrf,
  mutationRateLimit,
  async (req, res): Promise<void> => {
    const params = UpdateRunStationProgressParams.safeParse(req.params);
    const update = UpdateRunStationProgressBody.safeParse(req.body);
    if (!params.success || !update.success) {
      res.status(400).json({ error: "Invalid station progress update." });
      return;
    }
    const access = await membershipOrRespond(req, res);
    if (!access) return;

    const result = await updateRunStationProgress({
      facilityId: access.membership.facilityId,
      actorUserId: access.actorId,
      runId: params.data.runId,
      stationId: params.data.stationId,
      update: update.data,
    });
    if (result.outcome === "conflict") {
      res.status(409).json({ error: result.error, current: result.current });
      return;
    }
    res.json(UpdateRunStationProgressResponse.parse(result));
  },
);

router.get(
  "/dashboard/summary",
  requireV2Session,
  async (req, res): Promise<void> => {
  const access = await membershipOrRespond(req, res);
  if (!access) return;

  const [statusCounts, activeRuns, recentRuns] = await Promise.all([
    db
      .select({ status: productionRunsTable.status, total: count() })
      .from(productionRunsTable)
      .where(eq(productionRunsTable.facilityId, access.membership.facilityId))
      .groupBy(productionRunsTable.status),
    db
      .select()
      .from(productionRunsTable)
      .where(
        and(
          eq(productionRunsTable.facilityId, access.membership.facilityId),
          inArray(productionRunsTable.status, ["running", "paused"]),
        ),
      )
      .orderBy(desc(productionRunsTable.updatedAt))
      .limit(10),
    db
      .select()
      .from(productionRunsTable)
      .where(eq(productionRunsTable.facilityId, access.membership.facilityId))
      .orderBy(desc(productionRunsTable.updatedAt))
      .limit(8),
  ]);

  const counts = { active: 0, planned: 0, completed: 0 };
  for (const item of statusCounts) {
    if (item.status === "running" || item.status === "paused") {
      counts.active += item.total;
    } else if (item.status === "draft" || item.status === "planned") {
      counts.planned += item.total;
    } else if (item.status === "completed") {
      counts.completed = item.total;
    }
  }
  const facility = {
    id: access.membership.facilityId,
    name: access.membership.facilityName,
    createdAt: access.membership.facilityCreatedAt,
  };

  res.json(
    GetDashboardSummaryResponse.parse({
      facility,
      counts,
      activeRuns: activeRuns.map(toContractRun),
      recentRuns: recentRuns.map(toContractRun),
    }),
  );
});

export default router;
