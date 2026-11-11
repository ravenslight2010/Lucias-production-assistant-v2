import { createInsertSchema } from "drizzle-zod";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const facilityRoleEnum = pgEnum("facility_role", [
  "owner",
  "manager",
  "operator",
]);

export const runStatusEnum = pgEnum("run_status", [
  "planned",
  // Kept temporarily so existing V2 draft rows can be read and normalized.
  "draft",
  "running",
  "paused",
  "completed",
]);

export const facilitiesTable = pgTable("facilities", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const facilityMembersTable = pgTable(
  "facility_members",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilitiesTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: facilityRoleEnum("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("facility_members_user_id_uq").on(table.userId),
    index("facility_members_facility_id_idx").on(table.facilityId),
  ],
);

export const productionRunsTable = pgTable(
  "production_runs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilitiesTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // Older V2 rows stored only a name, so the additive upgrade uses one as
    // the smallest valid target rather than guessing a historical quantity.
    targetCases: integer("target_cases").notNull().default(1),
    status: runStatusEnum("status").notNull().default("planned"),
    revision: integer("revision").notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    resumedAt: timestamp("resumed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    pauseIntervals: jsonb("pause_intervals")
      .$type<Array<{ startedAt: string; endedAt: string | null }>>()
      .notNull()
      .default([]),
  },
  (table) => [
    index("production_runs_facility_status_updated_idx").on(
      table.facilityId,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const runEventsTable = pgTable(
  "run_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilitiesTable.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => productionRunsTable.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").notNull(),
    action: text("action").notNull(),
    fromStatus: runStatusEnum("from_status"),
    toStatus: runStatusEnum("to_status").notNull(),
    revision: integer("revision").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("run_events_facility_run_revision_idx").on(
      table.facilityId,
      table.runId,
      table.revision,
    ),
  ],
);

export const runCommandReceiptsTable = pgTable(
  "run_command_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilitiesTable.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => productionRunsTable.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    result: jsonb("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("run_command_receipts_actor_key_uq").on(
      table.facilityId,
      table.actorUserId,
      table.runId,
      table.idempotencyKey,
    ),
    index("run_command_receipts_run_created_idx").on(
      table.runId,
      table.createdAt,
    ),
  ],
);

export const runCreateReceiptsTable = pgTable(
  "run_create_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilitiesTable.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").notNull(),
    requestId: uuid("request_id").notNull(),
    requestHash: text("request_hash").notNull(),
    runId: uuid("run_id")
      .notNull()
      .references(() => productionRunsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("run_create_receipts_actor_request_uq").on(
      table.facilityId,
      table.actorUserId,
      table.requestId,
    ),
  ],
);

export const runOutboxTable = pgTable(
  "run_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilitiesTable.id, { onDelete: "cascade" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => productionRunsTable.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    event: jsonb("event").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
  },
  (table) => [
    uniqueIndex("run_outbox_run_revision_uq").on(table.runId, table.revision),
    index("run_outbox_pending_idx").on(table.deliveredAt, table.createdAt),
  ],
);

export const insertFacilitySchema = createInsertSchema(facilitiesTable).omit({
  id: true,
  createdAt: true,
});

export type InsertFacility = z.infer<typeof insertFacilitySchema>;
export type Facility = typeof facilitiesTable.$inferSelect;
export type FacilityMember = typeof facilityMembersTable.$inferSelect;
export type ProductionRun = typeof productionRunsTable.$inferSelect;
export type RunEvent = typeof runEventsTable.$inferSelect;
export type RunCommandReceipt = typeof runCommandReceiptsTable.$inferSelect;
export type RunCreateReceipt = typeof runCreateReceiptsTable.$inferSelect;
export type RunOutboxEvent = typeof runOutboxTable.$inferSelect;
