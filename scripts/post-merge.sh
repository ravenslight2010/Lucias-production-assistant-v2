#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

pnpm install --frozen-lockfile

# App-only merges do not need to touch the development database. Keep schema
# pushes limited to changes that can affect the database schema or push logic.
if git rev-parse --verify HEAD^ >/dev/null 2>&1 &&
   git diff --quiet HEAD^ HEAD -- \
     lib/db/src/schema \
     lib/db/drizzle.config.ts \
     lib/db/scripts/push.mjs; then
  echo "No database schema or push-script changes; skipping schema push."
  exit 0
fi

# Drizzle can log an interactive-terminal error and still exit zero.
# Keep strict confirmation enabled; never turn an unapplied schema into success.
schema_log="$(mktemp)"
trap 'rm -f "$schema_log"' EXIT
pnpm --filter @workspace/db push 2>&1 | tee "$schema_log"
if grep -Eq 'Error:|ERR_PNPM_|All changes were aborted' "$schema_log" ||
   ! grep -Eq 'No changes detected|No schema changes|Changes applied' "$schema_log"; then
  echo "Post-merge schema setup was not confirmed. Review the pending SQL with pnpm --filter @workspace/db run push --verbose in an interactive terminal; do not bypass strict confirmation." >&2
  exit 1
fi
