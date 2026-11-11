import {
  createSupervisor,
  supervisedServices,
} from "./supervisor-runtime";
import { logger } from "./lib/logger";

const supervisor = createSupervisor();
const poolMaxFor = (name: "api" | "worker") =>
  supervisedServices.find((service) => service.name === name)?.dbPoolMax;

process.once("SIGTERM", () => supervisor.stop("SIGTERM"));
process.once("SIGINT", () => supervisor.stop("SIGINT"));

logger.info(
  {
    apiPoolMax: poolMaxFor("api"),
    workerPoolMax: poolMaxFor("worker"),
  },
  "Starting supervised API and worker",
);
supervisor.start();
