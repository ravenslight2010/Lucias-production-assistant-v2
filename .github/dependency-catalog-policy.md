# Workspace dependency catalog policy

Use the default pnpm catalog in `pnpm-workspace.yaml` for every third-party
dependency declared by more than one workspace package. Package manifests should
refer to those shared versions with `"catalog:"`. Dependencies used by only one
workspace package may keep their version next to that package.

Peer dependency ranges describe compatibility promised by a library to its
consumers, so they are not replaced with the workspace's runtime version when
that would narrow the public compatibility contract. Any such exception must be
listed by dependency and manifest section in
`.github/dependency-catalog-exceptions.json`, with a reason.

The `pnpm check:dependency-catalog` command checks catalog references, repeated
direct dependencies, and documented exceptions. The existing Typecheck CI gate
runs the same check and its regression tests for pull requests and pushes to
`main`, so catalog policy is included in that required check.

Dependabot's npm workspace configuration remains grouped and weekly, with the
`increase` versioning strategy retained for its pnpm catalog updates. Updates to
catalog versions and the generated pnpm lockfile must pass the frozen install,
typecheck, build, unit/API tests, dependency review, and catalog checks before
branch protection permits merging.
