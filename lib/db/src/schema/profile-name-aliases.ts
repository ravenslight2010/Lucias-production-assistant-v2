import { pgTable, text, timestamp, uuid, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { facilitiesTable, facilityProductProfilesTable } from "./production.ts";

// Only names explicitly changed by an operator belong here, not inferred
// spelling similarities or recipe labels found inside a workbook.
export const profileNameAliasesTable = pgTable("profile_name_aliases", {
  id: uuid("id").primaryKey().defaultRandom(),
  facilityId: uuid("facility_id").notNull().references(() => facilitiesTable.id, { onDelete: "cascade" }),
  profileId: uuid("profile_id").notNull().references(() => facilityProductProfilesTable.id, { onDelete: "cascade" }),
  brand: text("brand").notNull(),
  flavor: text("flavor").notNull(),
  normalizedKey: text("normalized_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("profile_name_aliases_facility_key_uq").on(table.facilityId, table.normalizedKey),
  index("profile_name_aliases_profile_idx").on(table.profileId),
]);

export const insertProfileNameAliasSchema = createInsertSchema(profileNameAliasesTable).omit({ id: true, createdAt: true });
export type InsertProfileNameAlias = z.infer<typeof insertProfileNameAliasSchema>;
export type ProfileNameAlias = typeof profileNameAliasesTable.$inferSelect;
