# WP0 — Repo hygiene and truthful status

## Outcome

Updated the collaborator-facing product status and added the purpose-completion
checklist. The repo was already at the task baseline (`d7c74b5`); fetching
`origin/main` required no changes.

## Verification

- `corepack pnpm@9.15.9 install --frozen-lockfile` — passed; lockfile unchanged.
- `corepack pnpm@9.15.9 run typecheck` — passed.
- `PORT=4173 BASE_PATH=/ corepack pnpm@9.15.9 run build` — passed.
- V2 web tests — 77 passed.
- API tests — 95 passed, including disposable-PostgreSQL integration tests.
- `git diff --check` — passed.

This verification predates the repository's later PNPM 10.26.1 migration. The
PNPM 9.15.9 commands above are historical evidence only; current setup and CI
use the root-manifest PNPM 10.26.1 pin.
The lockfile and setup commands must be regenerated and verified with the
repository's pinned PNPM version.

## Superseded toolchain note

On 2026-11-13, the workspace was standardized on PNPM 10.26.1. The lockfile,
post-merge setup, GitHub Actions, and current instructions were migrated and
verified together.

## Limits

The signed-in browser journey was not run in this environment. No V1 account,
database, cookie, or production data was used. GitHub Actions were not run on
this documentation change, and nothing was pushed or published.
