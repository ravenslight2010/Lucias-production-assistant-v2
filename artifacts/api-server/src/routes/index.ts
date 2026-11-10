import { Router, type IRouter } from "express";
import healthRouter from "./health";
import productionRouter from "./production";

const router: IRouter = Router();

router.use(healthRouter);
router.use(productionRouter);

export default router;
