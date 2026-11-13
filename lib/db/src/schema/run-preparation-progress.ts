import { sql } from "drizzle-orm";
import {
  check,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { productionRunsTable } from "./production.ts";

export const runPreparationProgressTable = pgTable(
  "run_preparation_progress",
  {
    runId: uuid("run_id")
      .notNull()
      .references(() => productionRunsTable.id, { onDelete: "cascade" }),
    taskId: varchar("task_id", { length: 300 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("not_started"),
    revision: integer("revision").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: text("updated_by").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.runId, table.taskId],
      name: "run_preparation_progress_pk",
    }),
    check(
      "run_preparation_progress_status_chk",
      sql`${table.status} in ('not_started', 'in_progress', 'completed')`,
    ),
    check(
      "run_preparation_progress_revision_nonnegative_chk",
      sql`${table.revision} >= 0`,
    ),
  ],
);

export type RunPreparationProgress =
  typeof runPreparationProgressTable.$inferSelect;
