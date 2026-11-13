import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
  check,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { facilitiesTable, productionRunsTable } from "./production.ts";

export const runQualityMeasurementsTable = pgTable(
  "run_quality_measurements",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilitiesTable.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => productionRunsTable.id, { onDelete: "cascade" }),
    commandId: uuid("command_id").notNull(),
    requestHash: text("request_hash").notNull(),
    checkId: text("check_id").notNull(),
    checkType: text("check_type").notNull(),
    checkLabel: text("check_label").notNull(),
    source: text("source").notNull(),
    targetOz: numeric("target_oz", { precision: 20, scale: 6, mode: "number" }),
    minimumOz: numeric("minimum_oz", { precision: 20, scale: 6, mode: "number" })
      .notNull(),
    maximumOz: numeric("maximum_oz", { precision: 20, scale: 6, mode: "number" })
      .notNull(),
    toleranceOz: numeric("tolerance_oz", { precision: 10, scale: 6, mode: "number" }),
    observedOz: numeric("observed_oz", { precision: 20, scale: 6, mode: "number" })
      .notNull(),
    passed: boolean("passed").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("run_quality_measurements_command_check_uq").on(
      table.facilityId,
      table.runId,
      table.commandId,
      table.checkId,
    ),
    index("run_quality_measurements_facility_run_time_idx").on(
      table.facilityId,
      table.runId,
      table.createdAt,
    ),
    check(
      "run_quality_measurements_type_chk",
      sql`${table.checkType} IN ('ingredient_weight', 'finished_weight')`,
    ),
    check(
      "run_quality_measurements_bounds_chk",
      sql`${table.minimumOz} >= 0 AND ${table.maximumOz} >= ${table.minimumOz}`,
    ),
    check("run_quality_measurements_observed_nonnegative_chk", sql`${table.observedOz} >= 0`),
  ],
);

export const insertRunQualityMeasurementSchema = createInsertSchema(
  runQualityMeasurementsTable,
).omit({ id: true, createdAt: true });

export type InsertRunQualityMeasurement = z.infer<
  typeof insertRunQualityMeasurementSchema
>;
export type RunQualityMeasurement = typeof runQualityMeasurementsTable.$inferSelect;
