import { Router, type IRouter, type Request } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db, facilitiesTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import {
  getWorkerAvailability,
  type WorkerAvailability,
} from "../lib/worker-availability";

interface HealthRouterDependencies {
  checkDatabase?: (req: Request) => Promise<void>;
  getWorkerAvailability?: () => WorkerAvailability;
}

export function createHealthRouter(
  dependencies: HealthRouterDependencies = {},
): IRouter {
  const router: IRouter = Router();
  const getWorker =
    dependencies.getWorkerAvailability ?? getWorkerAvailability;
  const checkDatabase =
    dependencies.checkDatabase ??
    (async (req: Request): Promise<void> => {
      await db.execute(sql`select 1`);
      const pilotMarkerId = process.env.PILOT_MARKER_ID;
      if (process.env.NODE_ENV === "development" && pilotMarkerId) {
        const [marker] = await db
          .select({ id: facilitiesTable.id })
          .from(facilitiesTable)
          .where(eq(facilitiesTable.id, pilotMarkerId))
          .limit(1);
        if (!marker)
          throw new Error("The synthetic pilot marker was not found.");
        req.log.info(
          { syntheticMarkerVisible: true },
          "API pilot database check succeeded",
        );
      }
    });

  router.get("/healthz", async (req, res): Promise<void> => {
    const worker = getWorker();
    try {
      await checkDatabase(req);
      const healthy = worker === "available";
      const data = HealthCheckResponse.parse({
        status: healthy ? "ok" : "degraded",
        api: "ok",
        database: "ok",
        worker,
      });
      res.status(healthy ? 200 : 503).json(data);
    } catch (error) {
      req.log.error({ err: error }, "Database health check failed");
      res.status(503).json(
        HealthCheckResponse.parse({
          status: "degraded",
          api: "ok",
          database: "degraded",
          worker,
        }),
      );
    }
  });

  return router;
}

export default createHealthRouter();
