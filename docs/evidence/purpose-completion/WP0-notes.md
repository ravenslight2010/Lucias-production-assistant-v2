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

The shell's bare `pnpm` is 10.26.1 and rejects the patched lockfile metadata.
The repository CI installs PNPM 9, and the lockfile succeeds with PNPM 9.15.9.
The GitHub-sync instructions now specify the compatible Corepack command; do not
regenerate the lockfile with PNPM 10.

## Limits

The signed-in browser journey was not run in this environment. No V1 account,
database, cookie, or production data was used. GitHub Actions were not run on
this documentation change, and nothing was pushed or published.
