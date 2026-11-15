# Mandatory harness permissions — 2026-11-15

`patches/FinalPERSONALIZE.patch` now contains the complete 33-file permission change. The embedded segment is reproduced from `patches/HarnessPermissions.base.patch`, pinned by SHA-256 in `.github/scripts/check-personalize-hooks.cjs`. The original `HarnessPermissions.patch` and its manifest are retained unchanged as historical evidence.

The autorelease verifies the embedded segment on every attempt, including fallback attempts, and refuses to build on a base-patch conflict or missing/failing permission tests. It does not automatically resolve mandatory base conflicts. The workflow, patches, checker, and checker tests are mirrored in `deltav11`.

The segment was rebased onto upstream `46aefe3da30553099a8b8434d65aff1029a03235`. Real permission-service testing exposed and led to fixes for missing session-projector registration and failed-request pending cleanup.

## Verification

- Full upstream snapshot: all five release patches passed `git apply --check`; the upstream isolation/mandatory-permissions checker passed.
- A disposable indexed patch-stack check applied all five patches in release order, with no upstream owned-file collisions. No commits were made.
- Real permission tests: 124 passed, using a disposable source tree, cached dependencies and an in-memory database.
- Node permission tests: 21 passed; service dependencies used synthetic adapters.
- Patch checker tests: 15 passed, including negative checks for missing or modified mandatory permissions.
- Workflow YAML parsed and nine bash steps passed `bash -n`; CI was not run.

## Remaining limitations

The existing `personalize-src/base` in `deltav11` is older than the already-shipped base patch: 19 owned files are missing and 10 differ. Regeneration fails closed rather than overwrite or discard those potentially unique source versions. They require explicit reconciliation. The rebased generated SDK files have not been regenerated with the official generator since the upstream merge. No full OpenCode build, restart, CI run, commit, push, or publication was performed; these changes are local and undeployed.
