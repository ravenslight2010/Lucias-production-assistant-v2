import { and, count, desc, eq, gt, inArray, lte } from "drizzle-orm";
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
  GetDashboardSummaryResponse,
  GetFacilityContextResponse,
  GetRunParams,
  GetRunResponse,
  InviteFacilityMemberBody,
  InviteFacilityMemberResponse,
  ListFacilityMembersResponse,
  ListRunsQueryParams,
  ListRunsResponse,
  RemoveFacilityMemberParams,
  UpdateFacilityMemberBody,
  UpdateFacilityMemberParams,
  UpdateFacilityMemberResponse,
} from "@workspace/api-zod";
import {
  db,
  facilityInvitationsTable,
  facilitiesTable,
  facilityMembersTable,
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
import { createPlannedRun } from "../lib/run-create-service";
import { toContractRun } from "../lib/run-contract";
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
    if (!parsed.success || !parsed.data.setupSnapshot.label.trim()) {
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
      setupSnapshot: parsed.data.setupSnapshot,
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
