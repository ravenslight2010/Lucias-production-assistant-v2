import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  db,
  facilityStationLayoutsTable,
  productionRunsTable,
  runCommandReceiptsTable,
  runStationProgressTable,
} from "@workspace/db";
import type {
  RunStationProgress as DbRunStationProgress,
} from "@workspace/db";
import { HttpError } from "./http-error";
import { DEFAULT_FACILITY_STATIONS } from "./facility-stations";
import {
  buildRunStationProgressRows,
  stationStatusForRun,
  storedStationStatusForRun,
} from "./run-station-progress-logic";
import type {
  FacilityStationArea,
  FacilityStationForRun,
  RunStationProgressItem,
  RunStationProgressList,
  RunStationPreparationStatus,
  RunStationProgressStatus,
  StoredRunStationProgressStatus,
} from "./run-station-progress-logic";

export type {
  RunStationProgressItem,
  RunStationProgressList,
  RunStationPreparationStatus,
  RunStationProgressStatus,
} from "./run-station-progress-logic";

export type RunStationProgressUpdate = {
  commandId: string;
  expectedRevision: number;
  producedCount: number;
  preparationStatus: RunStationPreparationStatus;
};

export type RunStationProgressUpdateResult = {
  outcome: "accepted";
  replayed: boolean;
  station: RunStationProgressItem;
};

const stationAreas = new Set<FacilityStationArea>([
  "dough_sauce_prep",
  "production_line",
  "freezing_packaging",
  "warehouse",
]);

const storedProgressStatuses = new Set<StoredRunStationProgressStatus>([
  "not_started",
  "in_progress",
  "completed",
]);
const preparationStatuses = new Set<RunStationPreparationStatus>([
  "not_started",
  "in_progress",
  "ready",
  "not_required",
]);

function toProgressItem(
  row: DbRunStationProgress,
  runStatus: string,
): RunStationProgressItem {
  if (!stationAreas.has(row.stationArea as FacilityStationArea)) {
    throw new Error("Run station progress contains an invalid area.");
  }
  if (!storedProgressStatuses.has(row.status as StoredRunStationProgressStatus)) {
    throw new Error("Run station progress contains an invalid status.");
  }
  if (!preparationStatuses.has(row.preparationStatus as RunStationPreparationStatus)) {
    throw new Error("Run station progress contains an invalid preparation status.");
  }

  return {
    stationId: row.stationId,
    stationName: row.stationName,
    area: row.stationArea as FacilityStationArea,
    order: row.stationOrder,
    status: stationStatusForRun(runStatus),
    producedCount: row.producedCount,
    preparationStatus: row.preparationStatus as RunStationPreparationStatus,
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

function currentLineup(
  stations: FacilityStationForRun[],
  runStatus: string,
  updatedAt: Date | null,
) {
  const displayStatus = stationStatusForRun(runStatus);
  return buildRunStationProgressRows(
    "preview",
    stations,
    {
      status: storedStationStatusForRun(runStatus),
      updatedAt,
    },
  ).map((row) => ({
    stationId: row.stationId,
    stationName: row.stationName,
    area: row.stationArea,
    order: row.stationOrder,
    status: displayStatus,
    producedCount: row.producedCount,
    preparationStatus: row.preparationStatus,
    revision: row.revision,
    updatedAt: row.updatedAt?.toISOString() ?? null,
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
      startedAt: productionRunsTable.startedAt,
      pausedAt: productionRunsTable.pausedAt,
      resumedAt: productionRunsTable.resumedAt,
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
    return {
      initialized: true,
      stations: rows.map((row) => toProgressItem(row, run.status)),
    };
  }
  if (run.status === "completed") {
    return { initialized: false, stations: [] };
  }

  const stations = await activeFacilityStations(input.facilityId);
  const updatedAt =
    run.status === "paused"
      ? run.pausedAt
      : run.status === "running"
        ? run.resumedAt ?? run.startedAt
        : null;
  return {
    initialized: false,
    stations: currentLineup(stations, run.status, updatedAt),
  };
}

export async function updateRunStationProgress(input: {
  facilityId: string;
  actorUserId: string;
  runId: string;
  stationId: string;
  update: RunStationProgressUpdate;
}): Promise<
  | RunStationProgressUpdateResult
  | { outcome: "conflict"; error: string; current: RunStationProgressItem }
> {
  const { facilityId, actorUserId, runId, stationId, update } = input;
  const requestHash = createHash("sha256")
    .update(JSON.stringify({
      facilityId,
      actorUserId,
      runId,
      stationId,
      expectedRevision: update.expectedRevision,
      producedCount: update.producedCount,
      preparationStatus: update.preparationStatus,
    }))
    .digest("hex");

  return db.transaction(async (tx) => {
    const [run] = await tx
      .select({
        id: productionRunsTable.id,
        status: productionRunsTable.status,
      })
      .from(productionRunsTable)
      .where(
        and(
          eq(productionRunsTable.id, runId),
          eq(productionRunsTable.facilityId, facilityId),
        ),
      )
      .for("update")
      .limit(1);
    if (!run) throw new HttpError(404, "Run not found.");

    const [receipt] = await tx
      .select()
      .from(runCommandReceiptsTable)
      .where(
        and(
          eq(runCommandReceiptsTable.facilityId, facilityId),
          eq(runCommandReceiptsTable.actorUserId, actorUserId),
          eq(runCommandReceiptsTable.runId, runId),
          eq(runCommandReceiptsTable.idempotencyKey, update.commandId),
        ),
      )
      .limit(1);
    if (receipt) {
      if (receipt.requestHash !== requestHash) {
        const [current] = await tx
          .select()
          .from(runStationProgressTable)
          .where(
            and(
              eq(runStationProgressTable.runId, runId),
              eq(runStationProgressTable.stationId, stationId),
            ),
          )
          .limit(1);
        if (!current) throw new HttpError(404, "Station is not part of this run.");
        return {
          outcome: "conflict" as const,
          error: "This retry key was already used for a different update.",
          current: toProgressItem(current, run.status),
        };
      }
      const [current] = await tx
        .select()
        .from(runStationProgressTable)
        .where(
          and(
            eq(runStationProgressTable.runId, runId),
            eq(runStationProgressTable.stationId, stationId),
          ),
        )
        .limit(1);
      if (!current) throw new HttpError(404, "Station is not part of this run.");
      return {
        outcome: "accepted",
        replayed: true,
        station: toProgressItem(current, run.status),
      };
    }

    const [anySavedStation] = await tx
      .select({ stationId: runStationProgressTable.stationId })
      .from(runStationProgressTable)
      .where(eq(runStationProgressTable.runId, runId))
      .limit(1);
    if (!anySavedStation) {
      const [layout] = await tx
        .select({ stations: facilityStationLayoutsTable.stations })
        .from(facilityStationLayoutsTable)
        .where(eq(facilityStationLayoutsTable.facilityId, facilityId))
        .limit(1);
      const initialRows = buildRunStationProgressRows(
        runId,
        layout?.stations ?? DEFAULT_FACILITY_STATIONS,
        { status: storedStationStatusForRun(run.status) },
      );
      if (initialRows.length > 0) {
        await tx.insert(runStationProgressTable).values(initialRows).onConflictDoNothing();
      }
    }

    const [current] = await tx
      .select()
      .from(runStationProgressTable)
      .where(
        and(
          eq(runStationProgressTable.runId, runId),
          eq(runStationProgressTable.stationId, stationId),
        ),
      )
      .limit(1);
    if (!current) throw new HttpError(404, "Station is not part of this run.");

    const currentItem = toProgressItem(current, run.status);
    if (current.revision !== update.expectedRevision) {
      return {
        outcome: "conflict" as const,
        error: "This station changed on another device. Review the latest saved values before retrying.",
        current: currentItem,
      };
    }

    const now = new Date();
    const [saved] = await tx
      .update(runStationProgressTable)
      .set({
        producedCount: update.producedCount,
        preparationStatus: update.preparationStatus,
        revision: current.revision + 1,
        updatedAt: now,
        updatedBy: actorUserId,
      })
      .where(
        and(
          eq(runStationProgressTable.runId, runId),
          eq(runStationProgressTable.stationId, stationId),
          eq(runStationProgressTable.revision, update.expectedRevision),
        ),
      )
      .returning();
    if (!saved) {
      return {
        outcome: "conflict" as const,
        error: "This station changed on another device. Review the latest saved values before retrying.",
        current: currentItem,
      };
    }

    const result: RunStationProgressUpdateResult = {
      outcome: "accepted",
      replayed: false,
      station: toProgressItem(saved, run.status),
    };
    await tx.insert(runCommandReceiptsTable).values({
      facilityId,
      runId,
      actorUserId,
      idempotencyKey: update.commandId,
      requestHash,
      result,
    });
    return result;
  });
}
