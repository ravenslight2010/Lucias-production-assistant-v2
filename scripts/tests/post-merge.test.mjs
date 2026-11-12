import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = fileURLToPath(new URL("../post-merge.sh", import.meta.url));

function runSetup(
  output,
  { installStatus = 0, pushStatus = 0, dbChange = true } = {},
) {
  const directory = mkdtempSync(path.join(tmpdir(), "post-merge-test-"));
  try {
    writeFileSync(
      path.join(directory, "pnpm"),
      `#!/bin/bash
if [ "$1" = install ]; then
  [ "$2" = --frozen-lockfile ] || exit 99
  exit "$TEST_INSTALL_STATUS"
fi
[ "$*" = "--filter @workspace/db push" ] || exit 98
printf '%s\\n' "$TEST_SCHEMA_OUTPUT"
exit "$TEST_PUSH_STATUS"
`,
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(directory, "git"),
      `#!/bin/bash
if [ "$*" = "rev-parse --verify HEAD^" ]; then
  exit 0
fi
if [ "$*" = "diff --quiet HEAD^ HEAD -- lib/db/src/schema lib/db/drizzle.config.ts lib/db/scripts/push.mjs" ]; then
  exit "$TEST_DB_DIFF_STATUS"
fi
exit 97
`,
      { mode: 0o755 },
    );
    return spawnSync("bash", [script], {
      cwd: tmpdir(),
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        TEST_SCHEMA_OUTPUT: output,
        TEST_INSTALL_STATUS: String(installStatus),
        TEST_PUSH_STATUS: String(pushStatus),
        TEST_DB_DIFF_STATUS: dbChange ? "1" : "0",
      },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("skips schema push for merges without database changes", () => {
  const result = runSetup("", { dbChange: false });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No database schema or push-script changes/);
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
