import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = fileURLToPath(new URL("../post-merge.sh", import.meta.url));

function runSetup(
  output,
  { installStatus = 0, pushStatus = 0, multiCommit = false } = {},
) {
  const directory = mkdtempSync(path.join(tmpdir(), "post-merge-test-"));
  try {
    mkdirSync(path.join(directory, "scripts"));
    const copiedScript = path.join(directory, "scripts", "post-merge.sh");
    writeFileSync(copiedScript, readFileSync(script));
    let lastCommitPaths;
    if (multiCommit) {
      const git = (...args) => {
        const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout;
      };
      const commit = (message) => {
        git("add", ".");
        git("-c", "user.name=Setup test", "-c", "user.email=setup@example.com", "commit", "--quiet", "-m", message);
      };
      git("init", "--quiet");
      mkdirSync(path.join(directory, "lib", "db", "src", "schema"), { recursive: true });
      const schema = path.join(directory, "lib", "db", "src", "schema", "production.ts");
      writeFileSync(schema, "// initial schema\n");
      commit("initial");
      writeFileSync(schema, "// upgraded schema\n");
      commit("upgrade schema");
      writeFileSync(path.join(directory, "app.txt"), "app-only final commit\n");
      commit("update app");
      lastCommitPaths = git("diff", "--name-only", "HEAD^", "HEAD").trim();
    }
    writeFileSync(
      path.join(directory, "corepack"),
      `#!/bin/bash
if [ "$1" = "pnpm@10.26.1" ]; then
  shift
else
  exit 99
fi
if [ "$1" = install ]; then
  [ "$2" = --frozen-lockfile ] || exit 99
  exit "$TEST_INSTALL_STATUS"
fi
[ "$*" = "--filter @workspace/db push" ] || exit 98
printf '%s\\n' 'schema push invoked'
printf '%s\\n' "$TEST_SCHEMA_OUTPUT"
exit "$TEST_PUSH_STATUS"
`,
      { mode: 0o755 },
    );
    const result = spawnSync("bash", [copiedScript], {
      cwd: tmpdir(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        TEST_SCHEMA_OUTPUT: output,
        TEST_INSTALL_STATUS: String(installStatus),
        TEST_PUSH_STATUS: String(pushStatus),
      },
    });
    return { ...result, lastCommitPaths };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("checks schema changes from earlier commits when the final commit changes only the app", () => {
  const result = runSetup("No schema changes", { multiCommit: true });
  assert.equal(result.status, 0);
  assert.equal(result.lastCommitPaths, "app.txt");
  assert.match(result.stdout, /schema push invoked/);
});

test("does not hide a failed schema upgrade behind an app-only final commit", () => {
  const result = runSetup("Error: schema upgrade could not be completed", { multiCommit: true });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /schema push invoked/);
  assert.match(result.stderr, /schema setup was not confirmed/);
});

test("accepts an explicitly unchanged schema", () => {
  assert.equal(runSetup("[i] No changes detected").status, 0);
});

test("accepts the database push script's no-schema-changes result", () => {
  assert.equal(runSetup("[✓] No schema changes").status, 0);
});

test("accepts an explicitly applied schema", () => {
  assert.equal(runSetup("[✓] Changes applied").status, 0);
});

test("rejects a terminal error even when Drizzle exits zero", () => {
  const result = runSetup("Error: Interactive prompts require a TTY terminal");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /schema setup was not confirmed/);
});

test("rejects an aborted push even if another success marker was printed", () => {
  assert.equal(runSetup("Changes applied\nAll changes were aborted").status, 1);
});

test("rejects output without an explicit schema completion", () => {
  assert.equal(runSetup("[✓] Pulling schema from database...").status, 1);
});

test("propagates install and schema command failures", () => {
  assert.equal(runSetup("No changes detected", { installStatus: 17 }).status, 17);
  assert.equal(runSetup("No changes detected", { pushStatus: 23 }).status, 23);
});
