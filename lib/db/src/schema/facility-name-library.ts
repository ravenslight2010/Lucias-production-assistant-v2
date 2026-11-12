import { integer, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { facilitiesTable } from "./production.ts";

export type NameReference = { kind: "brand" | "flavor" | "recipe" | "ingredient"; brand: string; name: string };
export type NameRule = { source: NameReference; target: NameReference };

// Explicit operator decisions only. Workbook cells/formulas remain immutable.
export const facilityNameLibrariesTable = pgTable("facility_name_libraries", {
  facilityId: uuid("facility_id").primaryKey().references(() => facilitiesTable.id, { onDelete: "cascade" }),
  revision: integer("revision").notNull().default(0),
  rules: jsonb("rules").$type<NameRule[]>().notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const insertFacilityNameLibrarySchema = createInsertSchema(facilityNameLibrariesTable).omit({ updatedAt: true });
export type InsertFacilityNameLibrary = z.infer<typeof insertFacilityNameLibrarySchema>;
