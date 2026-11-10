import { and, count, desc, eq, inArray } from "drizzle-orm";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  CreateFacilityBody,
  CreateFacilityResponse,
  CreateRunBody,
  CreateRunResponse,
  GetDashboardSummaryResponse,
  GetFacilityContextResponse,
  GetRunParams,
  GetRunResponse,
  IssueRunCommandBody,
  IssueRunCommandParams,
  IssueRunCommandResponse,
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

const router: IRouter = Router();

router.use(requireAuth);

async function getFacilityMembership(userId: string) {
  const [membership] = await db
    .select({
      facilityId: facilitiesTable.id,
      facilityName: facilitiesTable.name,
      facilityCreatedAt: facilitiesTable.createdAt,
      role: facilityMembersTable.role,
    })
    .from(facilityMembersTable)
    .innerJoin(
      facilitiesTable,
      eq(facilityMembersTable.facilityId, facilitiesTable.id),
    )
    .where(eq(facilityMembersTable.userId, userId))
    .limit(1);
  return membership ?? null;
}

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
  "/facilities",
  csrfProtection,
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

router.get("/runs", async (req, res): Promise<void> => {
  const parsed = ListRunsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Choose a valid run status." });
    return;
  }
  const access = await membershipOrRespond(req, res);
  if (!access) return;

  const rows = await db
    .select()
    .from(productionRunsTable)
    .where(
      parsed.data.status
        ? and(
            eq(productionRunsTable.facilityId, access.membership.facilityId),
            eq(productionRunsTable.status, parsed.data.status),
          )
        : eq(productionRunsTable.facilityId, access.membership.facilityId),
    )
    .orderBy(desc(productionRunsTable.updatedAt))
    .limit(100);

  res.json(ListRunsResponse.parse(rows));
});

router.post(
  "/runs",
  csrfProtection,
  mutationRateLimit,
  async (req, res): Promise<void> => {
    const parsed = CreateRunBody.safeParse(req.body);
    if (!parsed.success || !parsed.data.name.trim()) {
      res.status(400).json({ error: "Enter a run name up to 120 characters." });
      return;
    }
    const access = await membershipOrRespond(req, res);
    if (!access) return;

    const [run] = await db
      .insert(productionRunsTable)
      .values({
        facilityId: access.membership.facilityId,
        name: parsed.data.name.trim(),
        createdBy: access.actorId,
      })
      .returning();

    res.status(201).json(CreateRunResponse.parse(run));
  },
);

router.get("/runs/:runId", async (req, res): Promise<void> => {
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
  res.json(GetRunResponse.parse(run));
});

router.post(
  "/runs/:runId/commands",
  csrfProtection,
  mutationRateLimit,
  async (req, res): Promise<void> => {
    const params = IssueRunCommandParams.safeParse(req.params);
    const command = IssueRunCommandBody.safeParse(req.body);
    if (!params.success || !command.success) {
      res.status(400).json({ error: "Invalid run command." });
      return;
    }
    const access = await membershipOrRespond(req, res);
    if (!access) return;

    const result = await executeRunCommand({
      facilityId: access.membership.facilityId,
      actorUserId: access.actorId,
      runId: params.data.runId,
      command: command.data,
    });
    res.json(IssueRunCommandResponse.parse(result));
  },
);

router.get("/dashboard/summary", async (req, res): Promise<void> => {
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

  const counts = { active: 0, draft: 0, completed: 0 };
  for (const item of statusCounts) {
    if (item.status === "running" || item.status === "paused") {
      counts.active += item.total;
    } else if (item.status === "draft" || item.status === "completed") {
      counts[item.status] = item.total;
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
      activeRuns,
      recentRuns,
    }),
  );
});

export default router;
