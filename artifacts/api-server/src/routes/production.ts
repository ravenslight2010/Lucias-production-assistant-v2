import { and, count, desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  ApplyRunCommandBody,
  ApplyRunCommandParams,
  ApplyRunCommandResponse,
  CreateFacilityBody,
  CreateFacilityResponse,
  CreateV2SessionResponse,
  CreateRunBody,
  CreateRunResponse,
  GetDashboardSummaryResponse,
  GetFacilityContextResponse,
  GetRunParams,
  GetRunResponse,
  ListRunsQueryParams,
  ListRunsResponse,
} from "@workspace/api-zod";
import {
  db,
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
  const membership = await getFacilityMembership(actorId);
  if (!membership) {
    res.status(403).json({ error: "Set up a facility before continuing." });
    return null;
  }
  return { actorId, membership };
}

router.get("/facility/context", async (req, res): Promise<void> => {
  const actorId = actorOrRespond(req, res);
  if (!actorId) return;
  const membership = await getFacilityMembership(actorId);
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
