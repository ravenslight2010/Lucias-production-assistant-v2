import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.NODE_ENV === "production") {
  throw new Error("The development pilot verification cannot run in production.");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const tempDatabase = await mkdtemp(path.join(tmpdir(), "lucia-v2-pilot-db-"));
const outputDirectory = await mkdtemp(
  path.join(root, "lib/db/tests/.pilot-verification-"),
);
let databaseStarted = false;

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function run(command, args, env, timeout = 180_000) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: "inherit",
    timeout,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Pilot verification command failed: ${command} ${args.join(" ")}`);
  }
}

const port = await freePort();
const databaseUser = encodeURIComponent(process.env.USER || "runner");
const env = {
  ...process.env,
  DATABASE_URL: `postgresql://${databaseUser}@127.0.0.1:${port}/postgres`,
  DB_POOL_MAX: "4",
  DB_APPLICATION_NAME: "lucia-v2-pilot-verification",
  NODE_ENV: "test",
  SESSION_SECRET: randomBytes(32).toString("base64url"),
};
delete env.NODE_TEST_CONTEXT;

try {
  run("initdb", [
    "-D",
    tempDatabase,
    "--auth=trust",
    "--no-locale",
    "-E",
    "UTF8",
  ], env);
  run("pg_ctl", [
    "-D",
    tempDatabase,
    "-o",
    `-h 127.0.0.1 -p ${port} -F -c unix_socket_directories=${tempDatabase}`,
    "-w",
    "start",
  ], env);
  databaseStarted = true;

  run("pnpm", ["--filter", "@workspace/db", "run", "push"], env);
  run("pnpm", ["--filter", "@workspace/api-server", "run", "build"], env);

  const childBundle = path.join(outputDirectory, "pilot-http-child.mjs");
  const integrationBundle = path.join(outputDirectory, "pilot-verification.integration.mjs");
  const esbuildBanner = [
    "import { createRequire as __bannerCrReq } from 'node:module';",
    "import __bannerPath from 'node:path';",
    "import __bannerUrl from 'node:url';",
    "globalThis.require = __bannerCrReq(import.meta.url);",
    "globalThis.__filename = __bannerUrl.fileURLToPath(import.meta.url);",
    "globalThis.__dirname = __bannerPath.dirname(globalThis.__filename);",
  ].join("\n");
  run("pnpm", [
    "--filter",
    "@workspace/api-server",
    "exec",
    "esbuild",
    path.join(root, "artifacts/api-server/test/pilot-http-child.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${childBundle}`,
    `--banner:js=${esbuildBanner}`,
    "--external:pg",
    "--external:pg-native",
  ], env);
  run("pnpm", [
    "--filter",
    "@workspace/api-server",
    "exec",
    "esbuild",
    path.join(root, "artifacts/api-server/tests/pilot-verification.integration.ts"),
    "--bundle",
    "--platform=node",
    "--format=esm",
    `--outfile=${integrationBundle}`,
    `--banner:js=${esbuildBanner}`,
    "--external:pg",
    "--external:pg-native",
  ], env);

  const integrationEnv = {
    ...env,
    PILOT_HTTP_CHILD_BUNDLE: childBundle,
  };
  run(process.execPath, ["--test", integrationBundle], integrationEnv, 120_000);
  run(process.execPath, [
    "--test",
    "artifacts/api-server/test/health.test.mjs",
    "artifacts/api-server/test/supervisor.test.mjs",
  ], integrationEnv, 120_000);
  process.stdout.write(
    "\nDevelopment pilot verification passed. This checks app and database recovery in a disposable local environment, not Replit VM overlap or external sign-in providers.\n",
  );
} finally {
  if (databaseStarted) {
    const stopped = spawnSync("pg_ctl", [
      "-D",
      tempDatabase,
      "-m",
      "fast",
      "-w",
      "stop",
    ], { cwd: root, env, stdio: "inherit", timeout: 30_000 });
    if (stopped.error) process.stderr.write(`${stopped.error.message}\n`);
  }
  await rm(tempDatabase, { recursive: true, force: true });
  await rm(outputDirectory, { recursive: true, force: true });
}
