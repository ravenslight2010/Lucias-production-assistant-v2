import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { createPoolWithValidatedMax } from "../src/pool-config.ts";

const dbPackageDir = path.resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const workspaceDir = path.resolve(dbPackageDir, "../..");
const entryPoint = path.join(dbPackageDir, "src/index.ts");
const fakePg = path.join(dbPackageDir, "tests/fake-pg.mjs");

let bundleDir;
let bundlePath;

before(async () => {
  bundleDir = await mkdtemp(path.join(os.tmpdir(), "lucia-db-pool-config-"));
  bundlePath = path.join(bundleDir, "db-index.mjs");

  execFileSync(
    "pnpm",
    [
      "--filter",
      "@workspace/api-server",
      "exec",
      "esbuild",
      entryPoint,
      "--bundle",
      "--platform=node",
      "--format=esm",
      `--alias:pg=${fakePg}`,
      `--outfile=${bundlePath}`,
    ],
    { cwd: workspaceDir, stdio: "inherit" },
  );
});

after(async () => {
  if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
});

test("passes API and worker database identity and pool limits to PostgreSQL", async () => {
  const originalEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    DB_APPLICATION_NAME: process.env.DB_APPLICATION_NAME,
    DB_POOL_MAX: process.env.DB_POOL_MAX,
  };

  try {
    for (const service of [
      { name: "api", applicationName: "lucia-v2-api", poolMax: 4 },
      { name: "worker", applicationName: "lucia-v2-worker", poolMax: 2 },
    ]) {
      process.env.DATABASE_URL = "postgres://test.invalid/test";
      process.env.DB_APPLICATION_NAME = service.applicationName;
      process.env.DB_POOL_MAX = String(service.poolMax);

      const { pool, configuredPoolMax } = await import(
        `${pathToFileURL(bundlePath).href}?service=${service.name}`
      );

      assert.equal(
        pool.options.application_name,
        service.applicationName,
        `${service.name} application name`,
      );
      assert.equal(
        pool.options.max,
        service.poolMax,
        `${service.name} pool maximum`,
      );
      assert.equal(configuredPoolMax, service.poolMax);
    }
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("uses the default pool limit when DB_POOL_MAX is missing", () => {
  const createdLimits = [];
  const result = createPoolWithValidatedMax(undefined, (poolMax) => {
    createdLimits.push(poolMax);
    return { poolMax };
  });

  assert.equal(result.poolMax, 4);
  assert.deepEqual(result.pool, { poolMax: 4 });
  assert.deepEqual(createdLimits, [4]);
});

test("rejects non-integer pool limits before creating a pool", () => {
  assertInvalidPoolMax("2.5");
});

test("rejects pool limits below the minimum before creating a pool", () => {
  assertInvalidPoolMax("0");
});

test("rejects pool limits above the maximum before creating a pool", () => {
  assertInvalidPoolMax("21");
});

test("accepts the configured pool limit boundaries", () => {
  for (const expected of [1, 20]) {
    const result = createPoolWithValidatedMax(String(expected), (poolMax) => ({
      poolMax,
    }));
    assert.equal(result.poolMax, expected);
    assert.deepEqual(result.pool, { poolMax: expected });
  }
});

function assertInvalidPoolMax(rawPoolMax) {
  let poolCreated = false;

  assert.throws(
    () =>
      createPoolWithValidatedMax(rawPoolMax, () => {
        poolCreated = true;
        return {};
      }),
    {
      message: "DB_POOL_MAX must be an integer between 1 and 20.",
    },
  );
  assert.equal(
    poolCreated,
    false,
    "invalid configuration must not create a pool",
  );
}
