import assert from "node:assert/strict";
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
  "facility invitation acceptance is verified against a disposable PostgreSQL database",
  { timeout: 240_000 },
  async () => {
    const postgresDir = await mkdtemp(path.join(os.tmpdir(), "lucia-invitations-pg-"));
    const bundleDir = await mkdtemp(
      path.join(root, "lib/db/tests/.invitation-tests-"),
    );
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
        NODE_ENV: "test",
      };
      delete childEnv.NODE_TEST_CONTEXT;

      run("initdb", ["-D", postgresDir, "--auth=trust", "--no-locale", "-E", "UTF8"], {
        env: childEnv,
      });
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
        { env: childEnv },
      );
      postgresStarted = true;

      run(
        "psql",
        [
          databaseUrl,
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          `
            CREATE TYPE facility_role AS ENUM ('owner', 'manager', 'operator');
            CREATE TABLE facilities (
              id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              name text NOT NULL,
              created_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE facility_members (
              id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
              user_id text NOT NULL UNIQUE,
              role facility_role NOT NULL,
              created_at timestamptz NOT NULL DEFAULT now()
            );
            CREATE TABLE facility_invitations (
              id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
              facility_id uuid NOT NULL REFERENCES facilities(id) ON DELETE CASCADE,
              email text NOT NULL UNIQUE,
              role facility_role NOT NULL,
              invited_by text NOT NULL,
              clerk_invitation_id text,
              created_at timestamptz NOT NULL DEFAULT now(),
              expires_at timestamptz NOT NULL
            );
          `,
        ],
        { env: childEnv },
      );

      const testFile = path.join(root, "artifacts/api-server/tests/facility-invitation.integration.ts");
      const bundleFile = path.join(bundleDir, "facility-invitation.integration.mjs");
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
          `--outfile=${bundleFile}`,
          "--external:pg",
          "--external:pg-native",
        ],
      );
      run(process.execPath, ["--test", bundleFile], { env: childEnv });
    } finally {
      if (postgresStarted) {
        run(
          "pg_ctl",
          ["-D", postgresDir, "-m", "fast", "-w", "stop"],
          { env: process.env },
        );
      }
      await rm(postgresDir, { recursive: true, force: true });
      await rm(bundleDir, { recursive: true, force: true });
    }
  },
);
