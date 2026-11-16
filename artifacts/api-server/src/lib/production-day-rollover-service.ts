import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import {
  db,
  productionRunsTable,
  runEventsTable,
  runOutboxTable,
} from "@workspace/db";

const productionDayTimezone = "America/Chicago";
const systemActorId = "system:production-day-rollover";

export async function closeUnfinishedRunsFromPriorDays(facilityId: string) {
  return db.transaction(async (tx) => {
    const timezone = sql`${productionDayTimezone}`;
    const scheduledDay = sql`COALESCE(
      ${productionRunsTable.scheduledFor},
      (${productionRunsTable.createdAt} AT TIME ZONE ${timezone})::date
    )`;
    const startedDay = sql`COALESCE(
      (${productionRunsTable.startedAt} AT TIME ZONE ${timezone})::date,
      (${productionRunsTable.createdAt} AT TIME ZONE ${timezone})::date
    )`;
    const runDay = sql`CASE
      WHEN ${productionRunsTable.status} IN ('planned', 'draft') THEN ${scheduledDay}
      ELSE ${startedDay}
    END`;
    const endedAtExpression = sql<Date>`CASE
      WHEN ${productionRunsTable.status} IN ('planned', 'draft') THEN
        ((${scheduledDay} + 1)::timestamp AT TIME ZONE ${timezone})
      ELSE
        ((${startedDay} + 1)::timestamp AT TIME ZONE ${timezone})
    END`;

    const expired = await tx
      .select({
        id: productionRunsTable.id,
        status: productionRunsTable.status,
        revision: productionRunsTable.revision,
        pauseIntervals: productionRunsTable.pauseIntervals,
        endedAt: endedAtExpression,
      })
      .from(productionRunsTable)
      .where(
        and(
          eq(productionRunsTable.facilityId, facilityId),
          inArray(productionRunsTable.status, ["draft", "planned", "running", "paused"]),
          lt(runDay, sql`(now() AT TIME ZONE ${timezone})::date`),
        ),
      )
      .for("update");

    if (expired.length === 0) return 0;

    const detectedAt = new Date();
    let closedRunCount = 0;
    for (const run of expired) {
      const endedAt =
        run.endedAt instanceof Date ? run.endedAt : new Date(String(run.endedAt));
      if (Number.isNaN(endedAt.getTime())) {
        throw new Error("Production-day rollover produced an invalid close time.");
      }
      const endedAtIso = endedAt.toISOString();
      const pauseIntervals = run.pauseIntervals.map((interval, index) =>
        index === run.pauseIntervals.length - 1 && interval.endedAt === null
          ? { ...interval, endedAt: endedAtIso }
          : interval,
      );
      const revision = run.revision + 1;
      const [updated] = await tx
        .update(productionRunsTable)
        .set({
          status: "incomplete",
          endedAt,
          pauseIntervals,
          revision,
          updatedAt: detectedAt,
        })
        .where(
          and(
            eq(productionRunsTable.id, run.id),
            eq(productionRunsTable.facilityId, facilityId),
            eq(productionRunsTable.status, run.status),
            eq(productionRunsTable.revision, run.revision),
          ),
        )
        .returning({ id: productionRunsTable.id });
      if (!updated) continue;
      closedRunCount += 1;

      const event = {
        runId: run.id,
        facilityId,
        actorUserId: systemActorId,
        commandId: randomUUID(),
        commandType: "production_day_rollover",
        fromStatus: run.status,
        toStatus: "incomplete",
        revision,
        occurredAt: endedAtIso,
      };
      await tx.insert(runEventsTable).values({
        facilityId,
        runId: run.id,
        actorUserId: systemActorId,
        action: "production_day_rollover",
        fromStatus: run.status,
        toStatus: "incomplete",
        revision,
        occurredAt: endedAt,
      });
      await tx.insert(runOutboxTable).values({
        facilityId,
        runId: run.id,
        revision,
        event,
      });
    }

    return closedRunCount;
  });
}
