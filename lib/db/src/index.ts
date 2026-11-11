import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

const rawPoolMax = process.env.DB_POOL_MAX ?? "4";
const poolMax = Number(rawPoolMax);

if (!Number.isSafeInteger(poolMax) || poolMax < 1 || poolMax > 20) {
  throw new Error("DB_POOL_MAX must be an integer between 1 and 20.");
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  application_name: process.env.DB_APPLICATION_NAME ?? "lucia-v2",
  connectionTimeoutMillis: 5_000,
  statement_timeout: 12_000,
  max: poolMax,
});

export const configuredPoolMax = poolMax;
export const db = drizzle(pool, { schema });

export * from "./schema";
