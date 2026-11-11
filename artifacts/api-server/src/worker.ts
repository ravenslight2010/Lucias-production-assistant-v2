import { eq, sql } from "drizzle-orm";
import { configuredPoolMax, db, facilitiesTable, pool } from "@workspace/db";
import { logger } from "./lib/logger";

const intervalMs = Number(process.env.WORKER_HEARTBEAT_MS ?? "30000");
if (!Number.isSafeInteger(intervalMs) || intervalMs < 10_000 || intervalMs > 300_000) {
  throw new Error("WORKER_HEARTBEAT_MS must be between 10000 and 300000.");
}

const pilotMarkerId = process.env.PILOT_MARKER_ID;
if (pilotMarkerId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pilotMarkerId)) {
  throw new Error("PILOT_MARKER_ID must be a UUID.");
}
if (pilotMarkerId && process.env.NODE_ENV !== "development") {
  throw new Error("PILOT_MARKER_ID is only allowed in development.");
}

let stopping = false;
let timer: NodeJS.Timeout | undefined;
let syntheticMarkerCreated = false;
let firstSuccessfulCheck = true;

async function checkDatabase(): Promise<void> {
  await db.execute(sql`select 1`);

  let syntheticMarkerFound: boolean | undefined;
  if (pilotMarkerId && !syntheticMarkerCreated) {
    await db
      .insert(facilitiesTable)
      .values({
        id: pilotMarkerId,
        name: "Synthetic V2 deployment pilot marker",
      })
      .onConflictDoNothing();
    const [marker] = await db
      .select({ id: facilitiesTable.id })
      .from(facilitiesTable)
      .where(eq(facilitiesTable.id, pilotMarkerId))
      .limit(1);
    syntheticMarkerFound = Boolean(marker);
    if (!syntheticMarkerFound) {
      throw new Error("The configured synthetic pilot marker was not found.");
    }
    syntheticMarkerCreated = true;
  }

  if (firstSuccessfulCheck) {
    logger.info(
      {
        dbPoolMax: configuredPoolMax,
        databaseCheck: "ok",
        ...(syntheticMarkerFound === undefined ? {} : { syntheticMarkerFound }),
      },
      "Worker database check succeeded",
    );
    firstSuccessfulCheck = false;
  }
}

async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (timer) clearTimeout(timer);
  logger.info({ signal }, "Worker shutting down");
  try {
    await pool.end();
    process.exit(0);
  } catch {
    logger.error({ signal }, "Worker database pool shutdown failed");
    process.exit(1);
  }
}

async function runHeartbeat(): Promise<void> {
  if (stopping) return;
  try {
    await checkDatabase();
  } catch (error) {
    const errorCode =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : "worker_check_failed";
    logger.error({ errorCode }, "Worker database check failed");
    try {
      await pool.end();
    } finally {
      process.exit(1);
    }
  }

  if (!stopping) {
    timer = setTimeout(() => void runHeartbeat(), intervalMs);
  }
}

process.once("SIGTERM", () => void stop("SIGTERM"));
process.once("SIGINT", () => void stop("SIGINT"));
void runHeartbeat();
