# GitHub ↔ Replit sync

V2 lives on GitHub and on Replit. When **GitHub `main` moves**, Replit should pull before more agent work.

## Automatic notice

On every push to `main`, workflow **Replit sync notice**:

1. Opens or updates a GitHub issue titled **“Replit sync: pull latest GitHub main”**
2. Labels it `replit-sync`
3. Comments with the new commit SHA and pull commands

**Issue search:** label [`replit-sync`](https://github.com/ravenslight2010/Lucias-production-assistant-v2/issues?q=label%3Areplit-sync)

## What to do on Replit

```bash
git fetch origin
git checkout main
git pull --ff-only origin main
pnpm install --frozen-lockfile
```

If the lockfile changed, commit only after a successful frozen install.

Comment on the tracker issue:

```text
synced <short-sha>
```

Then you can close the issue until the next GitHub push reopens/updates it.

## What to do after working on Replit

Push (or merge) back to GitHub `main` so CI runs. The same workflow will refresh the tracker for the next Replit pull.

```bash
git push origin main
```

Prefer PRs when CI protection requires green checks.

## Agent note

Replit agent: before large changes, check the open `replit-sync` issue (or `git status` / `git log HEAD..origin/main`) so the workspace is not behind GitHub.
