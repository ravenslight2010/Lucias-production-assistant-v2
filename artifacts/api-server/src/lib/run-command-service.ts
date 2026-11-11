import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  facilityStationLayoutsTable,
  productionRunsTable,
  runCommandReceiptsTable,
  runEventsTable,
  runOutboxTable,
  runStationProgressTable,
} from "@workspace/db";
import {
  buildRunStationProgressRows,
  storedStationStatusForRun,
} from "./run-station-progress-logic";
import { HttpError } from "./http-error";
import { transitionRun, type RunAction } from "./run-lifecycle";
import { toContractRun } from "./run-contract";
import { DEFAULT_FACILITY_STATIONS } from "./facility-stations";

export interface RunCommand {
  commandId: string;
  commandType: RunAction;
  expectedRevision: number;
}

export async function executeRunCommand(input: {
  facilityId: string;
  actorUserId: string;
  runId: string;
  command: RunCommand;
}) {
  const { facilityId, actorUserId, runId, command } = input;
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        facilityId,
        actorUserId,
        runId,
        commandType: command.commandType,
        expectedRevision: command.expectedRevision,
      }),
    )
    .digest("hex");

  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(productionRunsTable)
      .where(
        and(
          eq(productionRunsTable.id, runId),
          eq(productionRunsTable.facilityId, facilityId),
        ),
      )
      .for("update")
      .limit(1);

    if (!current) throw new HttpError(404, "Run not found.");

    const [receipt] = await tx
      .select()
      .from(runCommandReceiptsTable)
      .where(
        and(
          eq(runCommandReceiptsTable.facilityId, facilityId),
          eq(runCommandReceiptsTable.actorUserId, actorUserId),
          eq(runCommandReceiptsTable.runId, runId),
          eq(runCommandReceiptsTable.idempotencyKey, command.commandId),
        ),
      )
      .limit(1);

    if (receipt) {
      if (receipt.requestHash !== requestHash) {
        return {
          outcome: "conflict" as const,
          expectedRevision: command.expectedRevision,
          currentRun: toContractRun(current),
        };
      }
      return {
        outcome: "accepted" as const,
        replayed: true,
        commandId: command.commandId,
        run: toContractRun(current),
      };
    }

    if (current.revision !== command.expectedRevision) {
      return {
        outcome: "conflict" as const,
        expectedRevision: command.expectedRevision,
        currentRun: toContractRun(current),
      };
    }

    const now = new Date();
    let nextState;
    try {
      nextState = transitionRun(
        {
          status: current.status,
          startedAt: current.startedAt,
          pausedAt: current.pausedAt,
          resumedAt: current.resumedAt,
          completedAt: current.completedAt,
          pauseIntervals: current.pauseIntervals,
        },
        command.commandType,
        now,
      );
    } catch {
      return {
        outcome: "invalid_transition" as const,
        currentStatus: current.status === "draft" ? "planned" : current.status,
      };
    }

    const [updated] = await tx
      .update(productionRunsTable)
      .set({
        ...nextState,
        revision: current.revision + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(productionRunsTable.id, runId),
          eq(productionRunsTable.facilityId, facilityId),
        ),
      )
      .returning();

    if (!updated) throw new HttpError(404, "Run not found.");

    const [stationSnapshot] = await tx
      .select({ stationId: runStationProgressTable.stationId })
      .from(runStationProgressTable)
      .where(eq(runStationProgressTable.runId, runId))
      .limit(1);
    if (!stationSnapshot) {
      const [layout] = await tx
        .select({ stations: facilityStationLayoutsTable.stations })
        .from(facilityStationLayoutsTable)
        .where(eq(facilityStationLayoutsTable.facilityId, facilityId))
        .limit(1);
      const stationRows = buildRunStationProgressRows(
        runId,
        layout?.stations ?? DEFAULT_FACILITY_STATIONS,
        {
          status: storedStationStatusForRun(updated.status),
          revision: updated.revision,
          updatedAt: now,
          updatedBy: actorUserId,
        },
      );
      if (stationRows.length > 0) {
        await tx
          .insert(runStationProgressTable)
          .values(stationRows)
          .onConflictDoNothing();
      }
    } else {
      await tx
        .update(runStationProgressTable)
        .set({
          status: storedStationStatusForRun(updated.status),
          revision: updated.revision,
          updatedAt: now,
          updatedBy: actorUserId,
        })
        .where(eq(runStationProgressTable.runId, runId));
    }

    const result = {
      outcome: "accepted" as const,
      replayed: false,
      commandId: command.commandId,
      run: toContractRun(updated),
    };
    const event = {
      runId,
      facilityId,
      actorUserId,
      commandId: command.commandId,
      commandType: command.commandType,
      fromStatus: current.status === "draft" ? "planned" : current.status,
      toStatus: updated.status,
      revision: updated.revision,
      occurredAt: now.toISOString(),
    };

    await tx.insert(runEventsTable).values({
      facilityId,
      runId,
      actorUserId,
      action: command.commandType,
      fromStatus: current.status === "draft" ? "planned" : current.status,
      toStatus: updated.status,
      revision: updated.revision,
      occurredAt: now,
    });
    await tx.insert(runOutboxTable).values({
      facilityId,
      runId,
      revision: updated.revision,
      event,
    });
    await tx.insert(runCommandReceiptsTable).values({
      facilityId,
      runId,
      actorUserId,
      idempotencyKey: command.commandId,
      requestHash,
      result,
    });

    return result;
  });
}
