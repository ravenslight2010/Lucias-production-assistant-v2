import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  strict: process.env.DRIZZLE_PUSH_STRICT !== "false",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
