import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";
import { createPoolWithValidatedMax } from "./pool-config";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const { pool, poolMax: configuredPoolMax } = createPoolWithValidatedMax(
  process.env.DB_POOL_MAX,
  (max) =>
    new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: process.env.DB_APPLICATION_NAME ?? "lucia-v2",
      connectionTimeoutMillis: 5_000,
      statement_timeout: 12_000,
      max,
    }),
);

export { pool, configuredPoolMax };
export const db = drizzle(pool, { schema });

export * from "./schema";
