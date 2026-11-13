import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import {
  check,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { facilitiesTable, productionRunsTable } from "./production.ts";

export const facilityInventoryTable = pgTable(
  "facility_inventory",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilitiesTable.id, { onDelete: "cascade" }),
    ingredientKey: text("ingredient_key").notNull(),
    ingredientName: text("ingredient_name").notNull(),
    unit: text("unit").notNull(),
    onHand: numeric("on_hand", { precision: 20, scale: 6, mode: "number" })
      .notNull()
      .default(0),
    revision: integer("revision").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("facility_inventory_facility_ingredient_unit_uq").on(
      table.facilityId,
      table.ingredientKey,
      table.unit,
    ),
    index("facility_inventory_facility_name_idx").on(
      table.facilityId,
      table.ingredientName,
    ),
    check("facility_inventory_revision_nonnegative_chk", sql`${table.revision} >= 0`),
  ],
);

export const runInventoryReconciliationsTable = pgTable(
  "run_inventory_reconciliations",
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
    actorUserId: text("actor_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("run_inventory_reconciliations_facility_run_uq").on(
      table.facilityId,
      table.runId,
    ),
    uniqueIndex("run_inventory_reconciliations_facility_command_uq").on(
      table.facilityId,
      table.commandId,
    ),
    index("run_inventory_reconciliations_facility_created_idx").on(
      table.facilityId,
      table.createdAt,
    ),
  ],
);

export const inventoryTransactionsTable = pgTable(
  "inventory_transactions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    facilityId: uuid("facility_id")
      .notNull()
      .references(() => facilitiesTable.id, { onDelete: "cascade" }),
    inventoryId: uuid("inventory_id")
      .notNull()
      .references(() => facilityInventoryTable.id, { onDelete: "cascade" }),
    reconciliationId: uuid("reconciliation_id").references(
      () => runInventoryReconciliationsTable.id,
      { onDelete: "cascade" },
    ),
    runId: uuid("run_id").references(() => productionRunsTable.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull(),
    delta: numeric("delta", { precision: 20, scale: 6, mode: "number" }).notNull(),
    note: text("note").notNull(),
    correctsEntryId: uuid("corrects_entry_id"),
    commandId: uuid("command_id"),
    requestHash: text("request_hash"),
    ingredientName: text("ingredient_name").notNull(),
    unit: text("unit").notNull(),
    source: text("source").notNull(),
    proposalId: text("proposal_id"),
    requirementId: text("requirement_id"),
    requirementName: text("requirement_name"),
    sourceAmount: numeric("source_amount", {
      precision: 20,
      scale: 6,
      mode: "number",
    }),
    quantityBasis: text("quantity_basis").notNull().default("unresolved"),
    amountColumn: text("amount_column"),
    batchColumn: integer("batch_column"),
    proposedQuantity: numeric("proposed_quantity", {
      precision: 20,
      scale: 6,
      mode: "number",
    }),
    actualUsed: numeric("actual_used", {
      precision: 20,
      scale: 6,
      mode: "number",
    }),
    actorUserId: text("actor_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("inventory_transactions_facility_created_idx").on(
      table.facilityId,
      table.createdAt,
    ),
    index("inventory_transactions_inventory_created_idx").on(
      table.inventoryId,
      table.createdAt,
    ),
    uniqueIndex("inventory_transactions_facility_command_uq").on(
      table.facilityId,
      table.commandId,
    ),
    check(
      "inventory_transactions_kind_chk",
      sql`${table.kind} in ('run_usage', 'stock_adjustment', 'correction')`,
    ),
    check(
      "inventory_transactions_delta_range_chk",
      sql`${table.delta} > -1000000000000 and ${table.delta} < 1000000000000`,
    ),
  ],
);

export const insertFacilityInventorySchema = createInsertSchema(
  facilityInventoryTable,
).omit({ id: true, updatedAt: true });
export type InsertFacilityInventory = z.infer<typeof insertFacilityInventorySchema>;
export type FacilityInventory = typeof facilityInventoryTable.$inferSelect;
export type InventoryTransaction = typeof inventoryTransactionsTable.$inferSelect;
