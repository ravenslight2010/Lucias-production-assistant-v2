#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

pnpm install --frozen-lockfile

# Always verify the schema. HEAD^ only covers the final commit of a multi-commit
# update, so it cannot safely determine whether an upgrade is needed.
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
