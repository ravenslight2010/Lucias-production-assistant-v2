import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { facilitiesTable, facilityProductProfilesTable } from "./production.ts";

export const facilityImportBatchesTable = pgTable(
  "facility_import_batches",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilitiesTable.id, { onDelete: "cascade" }),
    sourceName: text("source_name").notNull(),
    sourceHash: text("source_hash").notNull(),
    importKind: text("import_kind").notNull(),
    status: text("status").notNull().default("draft"),
    proposedBrand: text("proposed_brand"),
    proposedFlavor: text("proposed_flavor"),
    workbookData: jsonb("workbook_data").notNull(),
    summary: jsonb("summary").notNull(),
    profileId: uuid("profile_id").references(() => facilityProductProfilesTable.id, {
      onDelete: "set null",
    }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
  },
  (table) => [
    check(
      "facility_import_batches_status_chk",
      sql`${table.status} IN ('draft', 'applied')`,
    ),
    check(
      "facility_import_batches_kind_chk",
      sql`${table.importKind} IN ('product_specs', 'premix', 'cheese', 'shipping', 'sauce_guide', 'dough_guide', 'schedule')`,
    ),
    index("facility_import_batches_facility_created_idx").on(table.facilityId, table.createdAt),
  ],
);

export type FacilityProductProfile = typeof facilityProductProfilesTable.$inferSelect;
export type FacilityImportBatch = typeof facilityImportBatchesTable.$inferSelect;
