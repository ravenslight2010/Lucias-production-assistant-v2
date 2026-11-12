import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { productionRunsTable } from "./production.ts";

export const runStationProgressTable = pgTable(
  "run_station_progress",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => productionRunsTable.id, { onDelete: "cascade" }),
    stationId: varchar("station_id", { length: 80 }).notNull(),
    stationName: varchar("station_name", { length: 80 }).notNull(),
    stationArea: varchar("station_area", { length: 32 }).notNull(),
    stationOrder: integer("station_order").notNull(),
    status: varchar("status", { length: 16 })
      .notNull()
      .default("not_started"),
    producedCount: integer("produced_count").notNull().default(0),
    preparationStatus: varchar("preparation_status", { length: 16 })
      .notNull()
      .default("not_started"),
    revision: integer("revision").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }),
    updatedBy: text("updated_by"),
  },
  (table) => [
    primaryKey({
      columns: [table.runId, table.stationId],
      name: "run_station_progress_pk",
    }),
    check(
      "run_station_progress_status_chk",
      sql`${table.status} in ('not_started', 'in_progress', 'completed')`,
    ),
    check(
      "run_station_progress_produced_count_nonnegative_chk",
      sql`${table.producedCount} >= 0`,
    ),
    check(
      "run_station_progress_preparation_status_chk",
      sql`${table.preparationStatus} in ('not_started', 'in_progress', 'ready', 'not_required')`,
    ),
    check(
      "run_station_progress_revision_nonnegative_chk",
      sql`${table.revision} >= 0`,
    ),
    check(
      "run_station_progress_order_nonnegative_chk",
      sql`${table.stationOrder} >= 0`,
    ),
    index("run_station_progress_run_order_idx").on(
      table.runId,
      table.stationOrder,
    ),
  ],
);

export const insertRunStationProgressSchema = createInsertSchema(
  runStationProgressTable,
).omit({ updatedAt: true });

export type InsertRunStationProgress = z.infer<
  typeof insertRunStationProgressSchema
>;
export type RunStationProgress = typeof runStationProgressTable.$inferSelect;
