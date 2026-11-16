import { Router, type IRouter } from "express";
import productionRouter from "./production";

const router: IRouter = Router();

// /api/healthz is mounted in app.ts before Clerk middleware.
router.use(productionRouter);

export default router;
