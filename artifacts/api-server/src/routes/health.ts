import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db, facilitiesTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { getWorkerAvailability } from "../lib/worker-availability";

const router: IRouter = Router();

router.get("/healthz", async (req, res): Promise<void> => {
  const worker = getWorkerAvailability();
  try {
    await db.execute(sql`select 1`);
    const pilotMarkerId = process.env.PILOT_MARKER_ID;
    if (process.env.NODE_ENV === "development" && pilotMarkerId) {
      const [marker] = await db
        .select({ id: facilitiesTable.id })
        .from(facilitiesTable)
        .where(eq(facilitiesTable.id, pilotMarkerId))
        .limit(1);
      if (!marker) throw new Error("The synthetic pilot marker was not found.");
      req.log.info({ syntheticMarkerVisible: true }, "API pilot database check succeeded");
    }
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

export default router;
