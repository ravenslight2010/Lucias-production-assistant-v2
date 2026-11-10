import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const router: IRouter = Router();

router.get("/healthz", async (req, res): Promise<void> => {
  try {
    await db.execute(sql`select 1`);
    const data = HealthCheckResponse.parse({ status: "ok" });
    res.json(data);
  } catch (error) {
    req.log.error({ err: error }, "Database health check failed");
    res.status(503).json(HealthCheckResponse.parse({ status: "degraded" }));
  }
});

export default router;
