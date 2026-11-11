import { and, asc, eq } from "drizzle-orm";
import {
  db,
  facilityStationLayoutsTable,
  productionRunsTable,
  runStationProgressTable,
} from "@workspace/db";
import type {
  RunStationProgress as DbRunStationProgress,
} from "@workspace/db";
import { HttpError } from "./http-error";
import { DEFAULT_FACILITY_STATIONS } from "./facility-stations";
import {
  buildRunStationProgressRows,
  planStationProgressUpdate,
} from "./run-station-progress-logic";
import type {
  FacilityStationArea,
  FacilityStationForRun,
  RunStationProgressItem,
  RunStationProgressList,
  RunStationProgressStatus,
} from "./run-station-progress-logic";

export type {
  RunStationProgressItem,
  RunStationProgressList,
  RunStationProgressStatus,
} from "./run-station-progress-logic";

const stationAreas = new Set<FacilityStationArea>([
  "dough_sauce_prep",
  "production_line",
  "freezing_packaging",
  "warehouse",
]);

const progressStatuses = new Set<RunStationProgressStatus>([
  "not_started",
  "in_progress",
  "completed",
]);

function toProgressItem(row: DbRunStationProgress): RunStationProgressItem {
  if (!stationAreas.has(row.stationArea as FacilityStationArea)) {
    throw new Error("Run station progress contains an invalid area.");
  }
  if (!progressStatuses.has(row.status as RunStationProgressStatus)) {
    throw new Error("Run station progress contains an invalid status.");
  }

  return {
    stationId: row.stationId,
    stationName: row.stationName,
    area: row.stationArea as FacilityStationArea,
    order: row.stationOrder,
    status: row.status as RunStationProgressStatus,
    revision: row.revision,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

async function rowsForRun(
  query: typeof db,
  runId: string,
): Promise<DbRunStationProgress[]> {
  return query
    .select()
    .from(runStationProgressTable)
    .where(eq(runStationProgressTable.runId, runId))
    .orderBy(asc(runStationProgressTable.stationOrder));
}

function currentLineup(stations: FacilityStationForRun[]) {
  return buildRunStationProgressRows("preview", stations).map((row) => ({
    stationId: row.stationId,
    stationName: row.stationName,
    area: row.stationArea,
    order: row.stationOrder,
    status: row.status,
    revision: row.revision,
    updatedAt: row.updatedAt,
  }));
}

async function activeFacilityStations(facilityId: string) {
  const [layout] = await db
    .select({ stations: facilityStationLayoutsTable.stations })
    .from(facilityStationLayoutsTable)
    .where(eq(facilityStationLayoutsTable.facilityId, facilityId))
    .limit(1);
  return layout?.stations ?? DEFAULT_FACILITY_STATIONS;
}

export async function getRunStationProgress(input: {
  facilityId: string;
  runId: string;
}): Promise<RunStationProgressList> {
  const [run] = await db
    .select({
      id: productionRunsTable.id,
      status: productionRunsTable.status,
    })
    .from(productionRunsTable)
    .where(
      and(
        eq(productionRunsTable.id, input.runId),
        eq(productionRunsTable.facilityId, input.facilityId),
      ),
    )
    .limit(1);
  if (!run) throw new HttpError(404, "Run not found.");

  const rows = await rowsForRun(db, run.id);
  if (rows.length > 0) {
    return { initialized: true, stations: rows.map(toProgressItem) };
  }
  if (run.status === "completed") {
    return { initialized: false, stations: [] };
  }

  const stations = await activeFacilityStations(input.facilityId);
  return {
    initialized: false,
    stations: currentLineup(stations),
  };
}

export async function updateRunStationProgress(input: {
  facilityId: string;
  actorUserId: string;
  runId: string;
  stationId: string;
  expectedRevision: number;
  status: RunStationProgressStatus;
}): Promise<
  | { outcome: "updated" | "unchanged"; current: RunStationProgressList }
  | { outcome: "conflict"; current: RunStationProgressList }
  | { outcome: "inactive"; current: RunStationProgressList }
  | { outcome: "not_found" }
> {
  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({
        id: productionRunsTable.id,
        status: productionRunsTable.status,
      })
      .from(productionRunsTable)
      .where(
        and(
          eq(productionRunsTable.id, input.runId),
          eq(productionRunsTable.facilityId, input.facilityId),
        ),
      )
      .for("update")
      .limit(1);
    if (!run) return { outcome: "not_found" };

    const readCurrent = async (): Promise<RunStationProgressList> => {
      const rows = await tx
        .select()
        .from(runStationProgressTable)
        .where(eq(runStationProgressTable.runId, run.id))
        .orderBy(asc(runStationProgressTable.stationOrder));
      if (rows.length > 0) {
        return { initialized: true, stations: rows.map(toProgressItem) };
      }
      const [layout] = await tx
        .select({ stations: facilityStationLayoutsTable.stations })
        .from(facilityStationLayoutsTable)
        .where(eq(facilityStationLayoutsTable.facilityId, input.facilityId))
        .limit(1);
      const stations = layout?.stations ?? DEFAULT_FACILITY_STATIONS;
      return {
        initialized: false,
        stations: currentLineup(stations),
      };
    };

    if (run.status !== "running" && run.status !== "paused") {
      return { outcome: "inactive", current: await readCurrent() };
    }

    let rows = await tx
      .select()
      .from(runStationProgressTable)
      .where(eq(runStationProgressTable.runId, run.id))
      .orderBy(asc(runStationProgressTable.stationOrder));
    if (rows.length === 0) {
      const [layout] = await tx
        .select({ stations: facilityStationLayoutsTable.stations })
        .from(facilityStationLayoutsTable)
        .where(eq(facilityStationLayoutsTable.facilityId, input.facilityId))
        .limit(1);
      const snapshot = buildRunStationProgressRows(
        run.id,
        layout?.stations ?? DEFAULT_FACILITY_STATIONS,
      );
      if (snapshot.length > 0) {
        await tx
          .insert(runStationProgressTable)
          .values(snapshot)
          .onConflictDoNothing();
      }
      rows = await tx
        .select()
        .from(runStationProgressTable)
        .where(eq(runStationProgressTable.runId, run.id))
        .orderBy(asc(runStationProgressTable.stationOrder));
    }

    const station = rows.find((row) => row.stationId === input.stationId);
    if (!station) return { outcome: "not_found" };

    const plan = planStationProgressUpdate(
      station,
      input.expectedRevision,
      input.status,
    );
    if (plan.type === "conflict") {
      return { outcome: "conflict", current: await readCurrent() };
    }
    if (plan.type === "unchanged") {
      return { outcome: "unchanged", current: await readCurrent() };
    }

    await tx
      .update(runStationProgressTable)
      .set({
        status: plan.status,
        revision: plan.revision,
        updatedAt: new Date(),
        updatedBy: input.actorUserId,
      })
      .where(
        and(
          eq(runStationProgressTable.runId, run.id),
          eq(runStationProgressTable.stationId, station.stationId),
          eq(runStationProgressTable.revision, input.expectedRevision),
        ),
      );

    return { outcome: "updated", current: await readCurrent() };
  });
}
