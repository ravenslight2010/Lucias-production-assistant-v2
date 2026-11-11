import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { check, integer, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { z } from "zod/v4";
import { facilitiesTable } from "./production";

export type FacilityStationArea =
  | "dough_sauce_prep"
  | "production_line"
  | "freezing_packaging"
  | "warehouse";

export type FacilityStation = {
  id: string;
  name: string;
  area: FacilityStationArea;
  isActive: boolean;
};

export const facilityStationLayoutsTable = pgTable(
  "facility_station_layouts",
  {
    facilityId: uuid("facility_id")
      .primaryKey()
      .references(() => facilitiesTable.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull().default(0),
    stations: jsonb("stations").$type<FacilityStation[]>().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      "facility_station_layout_revision_nonnegative_chk",
      sql`${table.revision} >= 0`,
    ),
    check(
      "facility_station_layout_stations_bounded_chk",
      sql`CASE WHEN jsonb_typeof(${table.stations}) = 'array' THEN jsonb_array_length(${table.stations}) <= 50 ELSE false END`,
    ),
  ],
);

export const insertFacilityStationLayoutSchema =
  createInsertSchema(facilityStationLayoutsTable).omit({ updatedAt: true });
export type InsertFacilityStationLayout = z.infer<
  typeof insertFacilityStationLayoutSchema
>;
export type FacilityStationLayout =
  typeof facilityStationLayoutsTable.$inferSelect;
