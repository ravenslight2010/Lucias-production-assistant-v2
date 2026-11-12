import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function run(command, args, { env = process.env, cwd = root } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    timeout: 180_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status ?? "unknown"}.`);
  }
}

test(
  "schedule import safeguards are verified against disposable PostgreSQL",
  { timeout: 240_000 },
  async () => {
    const postgresDir = await mkdtemp(path.join(os.tmpdir(), "lucia-schedule-import-pg-"));
    const bundleDir = await mkdtemp(path.join(root, "lib/db/tests/.schedule-import-tests-"));
    const portServer = createServer();
    let postgresStarted = false;
    let port;
    try {
      await new Promise((resolve, reject) => {
        portServer.once("error", reject);
        portServer.listen(0, "127.0.0.1", resolve);
      });
      port = portServer.address().port;
      await new Promise((resolve, reject) => {
        portServer.close((error) => (error ? reject(error) : resolve()));
      });

      const databaseUrl = `postgresql://${encodeURIComponent(process.env.USER || "runner")}@127.0.0.1:${port}/postgres`;
      const childEnv = {
        ...process.env,
        DATABASE_URL: databaseUrl,
        DB_POOL_MAX: "4",
        NODE_ENV: "test",
      };
      delete childEnv.NODE_TEST_CONTEXT;

      run("initdb", ["-D", postgresDir, "--auth=trust", "--no-locale", "-E", "UTF8"], {
        env: childEnv,
      });
      run("pg_ctl", [
        "-D",
        postgresDir,
        "-o",
        `-h 127.0.0.1 -p ${port} -F -c unix_socket_directories=${postgresDir}`,
        "-w",
        "start",
      ], { env: childEnv });
      postgresStarted = true;

      run("psql", [
        databaseUrl,
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        `
          CREATE TYPE run_status AS ENUM ('planned', 'draft', 'running', 'paused', 'completed');
          CREATE TABLE facilities (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            name text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now()
          );
          CREATE TABLE facility_product_profiles (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
            brand text NOT NULL,
            flavor text NOT NULL,
            normalized_key text NOT NULL,
            revision integer NOT NULL DEFAULT 0,
            product_data jsonb NOT NULL,
            merged_into_id uuid,
            created_by text NOT NULL,
            updated_at timestamptz NOT NULL DEFAULT now(),
            created_at timestamptz NOT NULL DEFAULT now()
          );
          CREATE TABLE facility_name_libraries (
            facility_id uuid PRIMARY KEY REFERENCES facilities(id) ON DELETE CASCADE,
            revision integer NOT NULL DEFAULT 0,
            rules jsonb NOT NULL DEFAULT '[]',
            updated_at timestamptz NOT NULL DEFAULT now()
          );
          CREATE TABLE facility_import_batches (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
            source_name text NOT NULL,
            source_hash text NOT NULL,
            import_kind text NOT NULL,
            status text NOT NULL DEFAULT 'draft',
            proposed_brand text,
            proposed_flavor text,
            workbook_data jsonb NOT NULL,
            summary jsonb NOT NULL,
            profile_id uuid REFERENCES facility_product_profiles(id) ON DELETE SET NULL,
            created_by text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            applied_at timestamptz
          );
          CREATE TABLE production_runs (
            id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
            name text NOT NULL,
            product_profile_id uuid REFERENCES facility_product_profiles(id) ON DELETE SET NULL,
            product_snapshot jsonb,
            target_cases integer NOT NULL DEFAULT 1,
            status run_status NOT NULL DEFAULT 'draft',
            revision integer NOT NULL DEFAULT 0,
            scheduled_for date,
            schedule_notes text,
            schedule_source jsonb,
            created_by text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            started_at timestamptz,
            paused_at timestamptz,
            resumed_at timestamptz,
            completed_at timestamptz,
            pause_intervals jsonb NOT NULL DEFAULT '[]'::jsonb
          );
        `,
      ], { env: childEnv });

      const testFile = path.join(root, "artifacts/api-server/tests/schedule-import.integration.ts");
      const bundleFile = path.join(bundleDir, "schedule-import.integration.mjs");
      run("pnpm", [
        "--filter",
        "@workspace/api-server",
        "exec",
        "esbuild",
        testFile,
        "--bundle",
        "--platform=node",
        "--format=esm",
        `--outfile=${bundleFile}`,
        "--external:pg",
        "--external:pg-native",
      ]);
      run(process.execPath, ["--test", bundleFile], { env: childEnv });
    } finally {
      if (postgresStarted) {
        run("pg_ctl", ["-D", postgresDir, "-m", "fast", "-w", "stop"], {
          env: process.env,
        });
      }
      await rm(postgresDir, { recursive: true, force: true });
      await rm(bundleDir, { recursive: true, force: true });
    }
  },
);
