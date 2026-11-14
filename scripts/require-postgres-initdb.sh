#!/usr/bin/env bash
set -euo pipefail

initdb_path="$(command -v initdb || true)"

if [[ -z "$initdb_path" ]] && command -v pg_config >/dev/null 2>&1; then
  postgres_bindir="$(pg_config --bindir 2>/dev/null || true)"
  if [[ -n "$postgres_bindir" && -x "$postgres_bindir/initdb" ]]; then
    initdb_path="$postgres_bindir/initdb"
  fi
fi

if [[ -z "$initdb_path" ]]; then
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      printf '%s\n\n' '## Database integration tests: NOT RUN'
      printf '%s\n' 'PostgreSQL `initdb` was not found. The database tests did not run; install or expose the PostgreSQL server binaries before retrying.'
    } >>"$GITHUB_STEP_SUMMARY"
  fi
  printf '%s\n' '::error title=Database integration tests unavailable::PostgreSQL initdb was not found; the database suite did not run.' >&2
  exit 1
fi

postgres_bindir="${initdb_path%/*}"
if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n' "$postgres_bindir" >>"$GITHUB_PATH"
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    printf '%s\n\n' '## Database integration tests: ready'
    printf 'Found PostgreSQL `initdb` at `%s`.\n' "$initdb_path"
  } >>"$GITHUB_STEP_SUMMARY"
fi

printf 'Found PostgreSQL initdb at: %s\n' "$initdb_path"
