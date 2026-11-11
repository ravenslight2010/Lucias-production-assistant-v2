import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const tempDir = path.join(root, "lib/db/tests/.tmp");
const postgresDir = await mkdtemp(path.join(os.tmpdir(), "lucia-v2-pg-"));
const portServer = createServer();
await new Promise((resolve, reject) => {
  portServer.once("error", reject);
  portServer.listen(0, "127.0.0.1", resolve);
});
const port = portServer.address().port;
await new Promise((resolve, reject) => {
  portServer.close((error) => (error ? reject(error) : resolve()));
});
const postgresUser = process.env.USER || "runner";
const testUrl = `postgresql://${encodeURIComponent(postgresUser)}@127.0.0.1:${port}/postgres`;
const childEnv = {
  ...process.env,
  DATABASE_URL: testUrl,
  SESSION_SECRET: "disposable-integration-test-secret-material-only",
  NODE_ENV: "test",
};
let postgresStarted = false;

function run(command, args, cwd, env = childEnv) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: "inherit",
    timeout: 180_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with status ${result.status ?? "unknown"}.`,
    );
  }
}

function runPsql(sql, databaseUrl = testUrl) {
  const result = spawnSync(
    "psql",
    [databaseUrl, "-v", "ON_ERROR_STOP=1", "-At", "-c", sql],
    {
      cwd: root,
      env: childEnv,
      encoding: "utf8",
      timeout: 30_000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `psql exited with status ${result.status ?? "unknown"}:\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

function assertEqual(description, actual, expected) {
  if (actual !== expected) {
    throw new Error(
      `${description} did not match the run-control contract.\n` +
        `Expected: ${expected}\nActual: ${actual}`,
    );
  }
}

const legacyFacilityId = "10000000-0000-4000-8000-000000000001";
const legacyRunId = "20000000-0000-4000-8000-000000000001";
const legacyRunningRunId = "20000000-0000-4000-8000-000000000002";
const legacyPausedRunId = "20000000-0000-4000-8000-000000000003";
const legacyCompletedRunId = "20000000-0000-4000-8000-000000000004";
const legacyRunEventId = "30000000-0000-4000-8000-000000000001";
const legacyCommandReceiptId = "40000000-0000-4000-8000-000000000001";
const legacyOutboxId = "50000000-0000-4000-8000-000000000001";
const legacyCreateRequestId = "60000000-0000-4000-8000-000000000001";
const legacyCreateReceiptId = "70000000-0000-4000-8000-000000000001";
const legacyCreateRequestHash = createHash("sha256")
  .update(JSON.stringify({ label: "Legacy V2 run label", targetCases: 1 }))
  .digest("hex");

try {
  run(
    "initdb",
    ["-D", postgresDir, "--auth=trust", "--no-locale", "-E", "UTF8"],
    root,
  );
  run(
    "pg_ctl",
    [
      "-D",
      postgresDir,
      "-o",
      `-h 127.0.0.1 -p ${port} -F -c unix_socket_directories=${postgresDir}`,
      "-w",
      "start",
    ],
    root,
  );
  postgresStarted = true;

  runPsql(`
    CREATE TYPE facility_role AS ENUM ('owner', 'manager', 'operator');
    CREATE TYPE run_status AS ENUM ('draft', 'running', 'paused', 'completed');
    CREATE TABLE facilities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE production_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
      name text NOT NULL,
      status run_status NOT NULL DEFAULT 'draft',
      revision integer NOT NULL DEFAULT 1,
      created_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      paused_at timestamptz,
      resumed_at timestamptz,
      completed_at timestamptz,
      pause_intervals jsonb NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE INDEX production_runs_facility_status_updated_idx
      ON production_runs (facility_id, status, updated_at);
    INSERT INTO facilities (id, name)
      VALUES ('${legacyFacilityId}', 'Legacy V2 fixture facility');
    INSERT INTO production_runs (id, facility_id, name, created_by)
      VALUES ('${legacyRunId}', '${legacyFacilityId}', 'Legacy V2 run label', 'legacy-user');
    INSERT INTO production_runs (
      id, facility_id, name, status, revision, created_by,
      created_at, updated_at, started_at, resumed_at, pause_intervals
    ) VALUES (
      '${legacyRunningRunId}', '${legacyFacilityId}', 'Legacy running run',
      'running', 7, 'legacy-running-user',
      '2024-02-01T08:00:00Z', '2024-02-02T08:15:00Z',
      '2024-02-01T08:10:00Z', '2024-02-01T09:00:00Z',
      '[{"startedAt":"2024-02-01T08:30:00.000Z","endedAt":"2024-02-01T09:00:00.000Z"}]'::jsonb
    );
    INSERT INTO production_runs (
      id, facility_id, name, status, revision, created_by,
      created_at, updated_at, started_at, paused_at, resumed_at, pause_intervals
    ) VALUES (
      '${legacyPausedRunId}', '${legacyFacilityId}', 'Legacy paused run',
      'paused', 8, 'legacy-paused-user',
      '2024-03-01T09:00:00Z', '2024-03-02T12:00:00Z',
      '2024-03-01T09:10:00Z', '2024-03-02T12:00:00Z',
      '2024-03-02T11:00:00Z',
      '[{"startedAt":"2024-03-01T10:30:00.000Z","endedAt":"2024-03-01T11:00:00.000Z"},{"startedAt":"2024-03-02T12:00:00.000Z","endedAt":null}]'::jsonb
    );
    INSERT INTO production_runs (
      id, facility_id, name, status, revision, created_by,
      created_at, updated_at, started_at, resumed_at, completed_at, pause_intervals
    ) VALUES (
      '${legacyCompletedRunId}', '${legacyFacilityId}', 'Legacy completed run',
      'completed', 10, 'legacy-completed-user',
      '2024-04-01T07:00:00Z', '2024-04-02T14:00:00Z',
      '2024-04-01T07:10:00Z', '2024-04-02T11:30:00Z',
      '2024-04-02T14:00:00Z',
      '[{"startedAt":"2024-04-01T08:00:00.000Z","endedAt":"2024-04-01T08:30:00.000Z"},{"startedAt":"2024-04-02T10:00:00.000Z","endedAt":"2024-04-02T11:30:00.000Z"}]'::jsonb
    );
    CREATE TABLE run_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
      run_id uuid NOT NULL REFERENCES production_runs(id) ON DELETE CASCADE,
      actor_user_id text NOT NULL,
      action text NOT NULL,
      from_status run_status,
      to_status run_status NOT NULL,
      revision integer NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE run_command_receipts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
      run_id uuid NOT NULL REFERENCES production_runs(id) ON DELETE CASCADE,
      actor_user_id text NOT NULL,
      idempotency_key text NOT NULL,
      request_hash text NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE run_create_receipts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
      actor_user_id text NOT NULL,
      request_id uuid NOT NULL,
      request_hash text NOT NULL,
      run_id uuid NOT NULL REFERENCES production_runs(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX run_create_receipts_actor_request_uq
      ON run_create_receipts (facility_id, actor_user_id, request_id);
    CREATE TABLE run_outbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
      run_id uuid NOT NULL REFERENCES production_runs(id) ON DELETE CASCADE,
      revision integer NOT NULL,
      event jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      delivered_at timestamptz,
      attempts integer NOT NULL DEFAULT 0
    );
    INSERT INTO run_events (
      id, facility_id, run_id, actor_user_id, action,
      from_status, to_status, revision, occurred_at
    ) VALUES (
      '${legacyRunEventId}', '${legacyFacilityId}', '${legacyRunningRunId}',
      'legacy-operator', 'start', 'draft', 'running', 7,
      '2024-02-01T08:10:00Z'
    );
    INSERT INTO run_command_receipts (
      id, facility_id, run_id, actor_user_id, idempotency_key,
      request_hash, result, created_at
    ) VALUES (
      '${legacyCommandReceiptId}', '${legacyFacilityId}', '${legacyRunningRunId}',
      'legacy-operator', 'legacy-start-command', 'sha256:legacy-request-hash',
      '{"outcome":"accepted","revision":7,"status":"running"}'::jsonb,
      '2024-02-01T08:10:01Z'
    );
    INSERT INTO run_create_receipts (
      id, facility_id, actor_user_id, request_id, request_hash, run_id, created_at
    ) VALUES (
      '${legacyCreateReceiptId}', '${legacyFacilityId}', 'legacy-owner',
      '${legacyCreateRequestId}', '${legacyCreateRequestHash}', '${legacyRunId}',
      '2024-01-31T07:00:00Z'
    );
    INSERT INTO run_outbox (
      id, facility_id, run_id, revision, event,
      created_at, delivered_at, attempts
    ) VALUES (
      '${legacyOutboxId}', '${legacyFacilityId}', '${legacyRunningRunId}', 7,
      '{"type":"run.updated","runId":"${legacyRunningRunId}","revision":7,"status":"running"}'::jsonb,
      '2024-02-01T08:10:02Z', NULL, 2
    );
    CREATE SCHEMA v1_archive;
    CREATE TABLE v1_archive.v1_runs (
      id text PRIMARY KEY,
      label text NOT NULL,
      target_cases integer NOT NULL
    );
    INSERT INTO v1_archive.v1_runs (id, label, target_cases)
      VALUES ('v1-fixture', 'V1 data stays separate', 37);
  `);

  run("pnpm", ["--filter", "@workspace/db", "run", "push"], root);
  const firstUpgradeSnapshot = runPsql(`
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', id,
          'name', name,
          'created_by', created_by,
          'status', status,
          'revision', revision,
          'created_at', created_at,
          'updated_at', updated_at,
          'started_at', started_at,
          'paused_at', paused_at,
          'resumed_at', resumed_at,
          'completed_at', completed_at,
          'pause_intervals', pause_intervals,
          'target_cases', target_cases
        )
        ORDER BY id
      ),
      '[]'::jsonb
    )::text
    FROM production_runs
  `);

  run("pnpm", ["--filter", "@workspace/db", "run", "push"], root);
  const repeatedUpgradeSnapshot = runPsql(`
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'id', id,
          'name', name,
          'created_by', created_by,
          'status', status,
          'revision', revision,
          'created_at', created_at,
          'updated_at', updated_at,
          'started_at', started_at,
          'paused_at', paused_at,
          'resumed_at', resumed_at,
          'completed_at', completed_at,
          'pause_intervals', pause_intervals,
          'target_cases', target_cases
        )
        ORDER BY id
      ),
      '[]'::jsonb
    )::text
    FROM production_runs
  `);
  if (repeatedUpgradeSnapshot !== firstUpgradeSnapshot) {
    throw new Error(
      `Repeated V2 schema push changed saved run history.\n` +
        `First push: ${firstUpgradeSnapshot}\n` +
        `Second push: ${repeatedUpgradeSnapshot}`,
    );
  }

  const v1Fixture = runPsql(
    "SELECT id || '|' || label || '|' || target_cases FROM v1_archive.v1_runs WHERE id = 'v1-fixture'",
  );
  if (v1Fixture !== "v1-fixture|V1 data stays separate|37") {
    throw new Error(`V1 fixture changed during V2 schema push: ${v1Fixture}`);
  }

  const cleanInstallDatabase = "clean_install";
  const cleanInstallUrl = `postgresql://${encodeURIComponent(postgresUser)}@127.0.0.1:${port}/${cleanInstallDatabase}`;
  runPsql(`CREATE DATABASE ${cleanInstallDatabase}`);
  run("pnpm", ["--filter", "@workspace/db", "run", "push"], root, {
    ...childEnv,
    DATABASE_URL: cleanInstallUrl,
  });

  const runStatusValues = runPsql(
    `SELECT string_agg(enumlabel, ',' ORDER BY enumsortorder)
     FROM pg_enum
     WHERE enumtypid = 'run_status'::regtype`,
    cleanInstallUrl,
  );
  assertEqual(
    "Fresh-install run_status values",
    runStatusValues,
    "planned,draft,running,paused,completed",
  );

  const runControlColumns = runPsql(
    `SELECT table_name || '.' || column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN (
         'production_runs',
         'run_events',
         'run_command_receipts',
         'run_create_receipts',
         'run_outbox'
       )
     ORDER BY table_name, ordinal_position`,
    cleanInstallUrl,
  );
  const expectedRunControlColumns = [
    "production_runs.id",
    "production_runs.facility_id",
    "production_runs.name",
    "production_runs.target_cases",
    "production_runs.status",
    "production_runs.revision",
    "production_runs.created_by",
    "production_runs.created_at",
    "production_runs.updated_at",
    "production_runs.started_at",
    "production_runs.paused_at",
    "production_runs.resumed_at",
    "production_runs.completed_at",
    "production_runs.pause_intervals",
    "run_command_receipts.id",
    "run_command_receipts.facility_id",
    "run_command_receipts.run_id",
    "run_command_receipts.actor_user_id",
    "run_command_receipts.idempotency_key",
    "run_command_receipts.request_hash",
    "run_command_receipts.result",
    "run_command_receipts.created_at",
    "run_create_receipts.id",
    "run_create_receipts.facility_id",
    "run_create_receipts.actor_user_id",
    "run_create_receipts.request_id",
    "run_create_receipts.request_hash",
    "run_create_receipts.run_id",
    "run_create_receipts.created_at",
    "run_events.id",
    "run_events.facility_id",
    "run_events.run_id",
    "run_events.actor_user_id",
    "run_events.action",
    "run_events.from_status",
    "run_events.to_status",
    "run_events.revision",
    "run_events.occurred_at",
    "run_outbox.id",
    "run_outbox.facility_id",
    "run_outbox.run_id",
    "run_outbox.revision",
    "run_outbox.event",
    "run_outbox.created_at",
    "run_outbox.delivered_at",
    "run_outbox.attempts",
  ].join("\n");
  assertEqual(
    "Fresh-install run-control columns",
    runControlColumns,
    expectedRunControlColumns,
  );

  const runControlDefaults = runPsql(
    `SELECT table_name || '.' || column_name || '=' || column_default
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (table_name, column_name) IN (
         ('production_runs', 'id'),
         ('production_runs', 'target_cases'),
         ('production_runs', 'status'),
         ('production_runs', 'revision'),
         ('production_runs', 'created_at'),
         ('production_runs', 'updated_at'),
         ('production_runs', 'pause_intervals'),
         ('run_events', 'id'),
         ('run_events', 'occurred_at'),
         ('run_command_receipts', 'id'),
         ('run_command_receipts', 'created_at'),
         ('run_create_receipts', 'id'),
         ('run_create_receipts', 'created_at'),
         ('run_outbox', 'id'),
         ('run_outbox', 'created_at'),
         ('run_outbox', 'attempts')
       )
     ORDER BY table_name, column_name`,
    cleanInstallUrl,
  );
  const expectedRunControlDefaults = [
    "production_runs.created_at=now()",
    "production_runs.id=gen_random_uuid()",
    "production_runs.pause_intervals='[]'::jsonb",
    "production_runs.revision=0",
    "production_runs.status='planned'::run_status",
    "production_runs.target_cases=1",
    "production_runs.updated_at=now()",
    "run_command_receipts.created_at=now()",
    "run_command_receipts.id=gen_random_uuid()",
    "run_create_receipts.created_at=now()",
    "run_create_receipts.id=gen_random_uuid()",
    "run_events.id=gen_random_uuid()",
    "run_events.occurred_at=now()",
    "run_outbox.attempts=0",
    "run_outbox.created_at=now()",
    "run_outbox.id=gen_random_uuid()",
  ].join("\n");
  assertEqual(
    "Fresh-install run-control defaults",
    runControlDefaults,
    expectedRunControlDefaults,
  );

  const insertedRunDefaults = runPsql(
    `WITH facility AS (
       INSERT INTO facilities (name)
       VALUES ('Fresh-install run-control fixture')
       RETURNING id
     ),
     inserted_run AS (
       INSERT INTO production_runs (facility_id, name, created_by)
       SELECT id, 'Fresh-install default run', 'test-user'
       FROM facility
       RETURNING id, status, revision, target_cases, pause_intervals,
         created_at IS NOT NULL AS has_created_at,
         updated_at IS NOT NULL AS has_updated_at
     )
     SELECT status || '|' || revision || '|' || target_cases || '|' ||
       pause_intervals::text || '|' || has_created_at || '|' || has_updated_at
     FROM inserted_run`,
    cleanInstallUrl,
  );
  assertEqual(
    "Fresh-install inserted-run defaults",
    insertedRunDefaults,
    "planned|0|1|[]|true|true",
  );

  await mkdir(tempDir, { recursive: true });
  await symlink(
    path.join(root, "artifacts/api-server/node_modules"),
    path.join(tempDir, "node_modules"),
    "dir",
  );
  const bundle = path.join(tempDir, "run-control.integration.mjs");
  const testFile = path.join(
    root,
    "artifacts/api-server/tests/run-control.integration.ts",
  );
  run(
    "pnpm",
    [
      "--filter",
      "@workspace/api-server",
      "exec",
      "esbuild",
      testFile,
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--external:express",
      "--external:cookie-parser",
      "--external:@clerk/express",
      `--outfile=${bundle}`,
      "--external:pg",
      "--external:pg-native",
    ],
    root,
  );
  run(process.execPath, ["--test", bundle], root);
} finally {
  await rm(tempDir, { recursive: true, force: true });
  if (postgresStarted) {
    run("pg_ctl", ["-D", postgresDir, "-m", "fast", "-w", "stop"], root);
  }
  await rm(postgresDir, { recursive: true, force: true });
}
