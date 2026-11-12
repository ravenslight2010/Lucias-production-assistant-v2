import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import {
  check,
  date,
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

export const facilityProductProfilesTable = pgTable(
  "facility_product_profiles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilitiesTable.id, { onDelete: "cascade" }),
    brand: text("brand").notNull(),
    flavor: text("flavor").notNull(),
    normalizedKey: text("normalized_key").notNull(),
    revision: integer("revision").notNull().default(0),
    productData: jsonb("product_data").notNull(),
    mergedIntoId: uuid("merged_into_id"),
    createdBy: text("created_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check("facility_product_profiles_revision_nonnegative_chk", sql`${table.revision} >= 0`),
    uniqueIndex("facility_product_profiles_facility_key_uq").on(table.facilityId, table.normalizedKey),
    index("facility_product_profiles_facility_brand_idx").on(table.facilityId, table.brand),
  ],
);

export const facilityInvitationsTable = pgTable(
  "facility_invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilitiesTable.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: facilityRoleEnum("role").notNull(),
    invitedBy: text("invited_by").notNull(),
    clerkInvitationId: text("clerk_invitation_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("facility_invitations_email_uq").on(table.email),
    index("facility_invitations_facility_id_idx").on(table.facilityId),
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
    productProfileId: uuid("product_profile_id").references(
      () => facilityProductProfilesTable.id,
      { onDelete: "set null" },
    ),
    productSnapshot: jsonb("product_snapshot"),
    // Older V2 rows stored only a name, so the additive upgrade uses one as
    // the smallest valid target rather than guessing a historical quantity.
    targetCases: integer("target_cases").notNull().default(1),
    // Keep the database fallback compatible with production; the API explicitly
    // sets "planned" when creating a new run.
    status: runStatusEnum("status").notNull().default("draft"),
    revision: integer("revision").notNull().default(0),
    scheduledFor: date("scheduled_for", { mode: "string" }),
    scheduleNotes: text("schedule_notes"),
    scheduleSource: jsonb("schedule_source").$type<{
      importId: string;
      file: string;
      sheet: string;
      row: number;
      brand: string;
      flavor: string;
    } | null>(),
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
    index("production_runs_facility_scheduled_for_idx").on(
      table.facilityId,
      table.scheduledFor,
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
    check(
      "run_events_action_nonblank_chk",
      sql`${table.action} ~ '[^[:space:]]'`,
    ),
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
    check(
      "run_command_receipts_idempotency_key_nonblank_chk",
      sql`${table.idempotencyKey} ~ '[^[:space:]]'`,
    ),
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
    // Deleting a run releases its create request ID for a later retry.
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
