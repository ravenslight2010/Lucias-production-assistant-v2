import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db, facilitiesTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.get("/healthz", async (req, res): Promise<void> => {
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
    const data = HealthCheckResponse.parse({ status: "ok" });
    res.json(data);
  } catch (error) {
    req.log.error({ err: error }, "Database health check failed");
    res.status(503).json(HealthCheckResponse.parse({ status: "degraded" }));
  }
});

export default router;
