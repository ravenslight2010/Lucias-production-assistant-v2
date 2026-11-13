import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  GetRunPreparationTasksResponse,
  type RunPreparationTask,
  type RunPreparationTaskStatus,
} from "@workspace/api-zod";
import {
  db,
  productionRunsTable,
  runCommandReceiptsTable,
  runPreparationProgressTable,
} from "@workspace/db";
import { HttpError } from "./http-error";

type PreparationStatus = RunPreparationTaskStatus;
type PreparationUpdate = {
  commandId: string;
  expectedRevision: number;
  status: PreparationStatus;
};

function capturedPullItems(runId: string, snapshot: unknown): RunPreparationTask[] {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return [];
  const runRequirements = (snapshot as Record<string, unknown>).runRequirements;
  if (!runRequirements || typeof runRequirements !== "object" || Array.isArray(runRequirements)) return [];
  const sourceItems = (runRequirements as Record<string, unknown>).preparationItems;
  if (sourceItems === undefined) return [];
  if (!Array.isArray(sourceItems) || sourceItems.length > 500) {
    throw new Error("The captured preparation pull list is malformed.");
  }
  return GetRunPreparationTasksResponse.parse({
    runId,
    tasks: sourceItems.map((item) => ({
      ...item as Record<string, unknown>,
      status: "not_started",
      revision: 0,
      updatedAt: null,
    })),
  }).tasks;
}

function withProgress(
  source: RunPreparationTask,
  row: typeof runPreparationProgressTable.$inferSelect | undefined,
): RunPreparationTask {
  const status = row?.status ?? "not_started";
  if (status !== "not_started" && status !== "in_progress" && status !== "completed") {
    throw new Error("Saved preparation progress has an invalid status.");
  }
  return {
    ...source,
    status,
    revision: row?.revision ?? 0,
    updatedAt: row?.updatedAt ?? null,
  };
}

async function runForFacility(
  query: Pick<typeof db, "select">,
  runId: string,
  facilityId: string,
) {
  const [run] = await query
    .select({
      id: productionRunsTable.id,
      status: productionRunsTable.status,
      productSnapshot: productionRunsTable.productSnapshot,
    })
    .from(productionRunsTable)
    .where(and(
      eq(productionRunsTable.id, runId),
      eq(productionRunsTable.facilityId, facilityId),
    ))
    .limit(1);
  if (!run) throw new HttpError(404, "Run not found.");
  return run;
}

export async function getRunPreparationTasks(input: {
  facilityId: string;
  runId: string;
}): Promise<{ runId: string; tasks: RunPreparationTask[] }> {
  const run = await runForFacility(db, input.runId, input.facilityId);
  const sourceItems = capturedPullItems(run.id, run.productSnapshot);
  const savedRows = sourceItems.length
    ? await db
        .select()
        .from(runPreparationProgressTable)
        .where(eq(runPreparationProgressTable.runId, run.id))
    : [];
  const savedById = new Map(savedRows.map((row) => [row.taskId, row]));
  return GetRunPreparationTasksResponse.parse({
    runId: run.id,
    tasks: sourceItems.map((item) => withProgress(item, savedById.get(item.id))),
  });
}

export async function updateRunPreparationTask(input: {
  facilityId: string;
  actorUserId: string;
  runId: string;
  taskId: string;
  update: PreparationUpdate;
}): Promise<
  | { outcome: "accepted"; replayed: boolean; task: RunPreparationTask }
  | { outcome: "conflict"; error: string; current: RunPreparationTask }
> {
  const { facilityId, actorUserId, runId, taskId, update } = input;
  const requestHash = createHash("sha256").update(JSON.stringify({
    facilityId,
    actorUserId,
    runId,
    taskId,
    expectedRevision: update.expectedRevision,
    status: update.status,
  })).digest("hex");

  return db.transaction(async (tx) => {
    const run = await runForFacility(tx, runId, facilityId);
    const [lockedRun] = await tx
      .select({ id: productionRunsTable.id, status: productionRunsTable.status, productSnapshot: productionRunsTable.productSnapshot })
      .from(productionRunsTable)
      .where(and(
        eq(productionRunsTable.id, run.id),
        eq(productionRunsTable.facilityId, facilityId),
      ))
      .for("update")
      .limit(1);
    if (!lockedRun) throw new HttpError(404, "Run not found.");
    if (lockedRun.status === "completed") {
      throw new HttpError(409, "Completed runs are read-only.");
    }

    const sourceTask = capturedPullItems(runId, lockedRun.productSnapshot)
      .find((task) => task.id === taskId);
    if (!sourceTask) throw new HttpError(404, "Preparation pull item not found.");

    const [receipt] = await tx
      .select()
      .from(runCommandReceiptsTable)
      .where(and(
        eq(runCommandReceiptsTable.facilityId, facilityId),
        eq(runCommandReceiptsTable.actorUserId, actorUserId),
        eq(runCommandReceiptsTable.runId, runId),
        eq(runCommandReceiptsTable.idempotencyKey, update.commandId),
      ))
      .limit(1);
    const [current] = await tx
      .select()
      .from(runPreparationProgressTable)
      .where(and(
        eq(runPreparationProgressTable.runId, runId),
        eq(runPreparationProgressTable.taskId, taskId),
      ))
      .limit(1);
    const currentTask = withProgress(sourceTask, current);

    if (receipt) {
      if (receipt.requestHash !== requestHash) {
        return {
          outcome: "conflict" as const,
          error: "This retry key was already used for a different update.",
          current: currentTask,
        };
      }
      return { outcome: "accepted" as const, replayed: true, task: currentTask };
    }
    if (currentTask.revision !== update.expectedRevision) {
      return {
        outcome: "conflict" as const,
        error: "This pull item changed on another device. Review the latest saved status before trying again.",
        current: currentTask,
      };
    }

    const now = new Date();
    const saved = current
      ? (await tx
          .update(runPreparationProgressTable)
          .set({
            status: update.status,
            revision: current.revision + 1,
            updatedAt: now,
            updatedBy: actorUserId,
          })
          .where(and(
            eq(runPreparationProgressTable.runId, runId),
            eq(runPreparationProgressTable.taskId, taskId),
            eq(runPreparationProgressTable.revision, update.expectedRevision),
          ))
          .returning())[0]
      : (await tx
          .insert(runPreparationProgressTable)
          .values({
            runId,
            taskId,
            status: update.status,
            revision: 1,
            updatedAt: now,
            updatedBy: actorUserId,
          })
          .returning())[0];

    if (!saved) {
      return {
        outcome: "conflict" as const,
        error: "This pull item changed on another device. Review the latest saved status before trying again.",
        current: currentTask,
      };
    }
    const result = {
      outcome: "accepted" as const,
      replayed: false,
      task: withProgress(sourceTask, saved),
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
