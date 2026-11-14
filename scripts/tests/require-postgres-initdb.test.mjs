import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../require-postgres-initdb.sh", import.meta.url));
const workflow = fileURLToPath(new URL("../../.github/workflows/api-integration.yml", import.meta.url));

test("finds initdb through pg_config and adds its directory to the GitHub path", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "postgres-initdb-test-"));
  try {
    const commands = path.join(directory, "commands");
    const postgresBin = path.join(directory, "postgres-bin");
    const githubPath = path.join(directory, "github-path");
    const summary = path.join(directory, "summary");
    mkdirSync(commands);
    mkdirSync(postgresBin);

    writeFileSync(
      path.join(commands, "pg_config"),
      "#!/bin/sh\nprintf '%s\\n' \"$MOCK_POSTGRES_BINDIR\"\n",
      { mode: 0o755 },
    );
    writeFileSync(path.join(postgresBin, "initdb"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const result = spawnSync("/bin/bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: commands,
        MOCK_POSTGRES_BINDIR: postgresBin,
        GITHUB_PATH: githubPath,
        GITHUB_STEP_SUMMARY: summary,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(githubPath, "utf8"), `${postgresBin}\n`);
    assert.match(readFileSync(summary, "utf8"), /Database integration tests: ready/);
    assert.match(result.stdout, new RegExp(postgresBin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fails and writes an explicit not-run summary when initdb is unavailable", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "postgres-initdb-missing-"));
  try {
    const emptyPath = path.join(directory, "empty-path");
    const summary = path.join(directory, "summary");
    mkdirSync(emptyPath);

    const result = spawnSync("/bin/bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: emptyPath,
        GITHUB_STEP_SUMMARY: summary,
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /database suite did not run/i);
    assert.match(readFileSync(summary, "utf8"), /Database integration tests: NOT RUN/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the integration workflow cannot skip its prerequisite check or database suite", () => {
  const source = readFileSync(workflow, "utf8");
  const prerequisiteCheck = source.indexOf("bash scripts/require-postgres-initdb.sh");
  const install = source.indexOf("pnpm install --frozen-lockfile");
  const databaseSuite = source.indexOf("pnpm --filter @workspace/db run test:run-control");

  assert.notEqual(prerequisiteCheck, -1);
  assert.ok(prerequisiteCheck < install);
  assert.ok(install < databaseSuite);
  assert.doesNotMatch(source, /^\s+if:/m);
});
