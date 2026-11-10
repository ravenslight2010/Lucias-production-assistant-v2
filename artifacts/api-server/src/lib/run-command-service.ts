import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  productionRunsTable,
  runCommandReceiptsTable,
  runEventsTable,
  runOutboxTable,
} from "@workspace/db";
import {
  IssueRunCommandResponse,
  IssueRunCommandBody,
  type RunCommandInput,
} from "@workspace/api-zod";
import { HttpError } from "./http-error";
import { transitionRun } from "./run-lifecycle";

export async function executeRunCommand(input: {
  facilityId: string;
  actorUserId: string;
  runId: string;
  command: RunCommandInput;
}) {
  const { facilityId, actorUserId, runId, command } = input;
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        facilityId,
        actorUserId,
        runId,
        action: command.action,
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
          eq(runCommandReceiptsTable.idempotencyKey, command.idempotencyKey),
        ),
      )
      .limit(1);

    if (receipt) {
      if (receipt.requestHash !== requestHash) {
        throw new HttpError(
          409,
          "This command key was already used for a different request.",
        );
      }
      const prior = receipt.result as { run?: unknown };
      return IssueRunCommandResponse.parse({
        run: prior.run,
        replayed: true,
      });
    }

    if (current.revision !== command.expectedRevision) {
      throw new HttpError(409, "Run changed. Refresh before trying again.");
    }

    const now = new Date();
    let nextState;
    try {
      nextState = transitionRun(current, command.action, now);
    } catch (error) {
      if (error instanceof Error) throw new HttpError(409, error.message);
      throw error;
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

    const result = IssueRunCommandResponse.parse({
      run: updated,
      replayed: false,
    });
    const event = {
      runId,
      facilityId,
      actorUserId,
      action: command.action,
      fromStatus: current.status,
      toStatus: updated.status,
      revision: updated.revision,
      occurredAt: now.toISOString(),
    };

    await tx.insert(runEventsTable).values({
      facilityId,
      runId,
      actorUserId,
      action: command.action,
      fromStatus: current.status,
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
      idempotencyKey: command.idempotencyKey,
      requestHash,
      result,
    });

    return result;
  });
}
