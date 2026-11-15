# Harness status — 2026-11-12

## Live correction
- Existing session API grants were applied and read back on the current conversation and 19 descendants for `finalsnap/*`, `deltav11/*`, and `C:/Users/o/AppData/Local/Temp/opencode/*`.
- Existing rules remain intact. Future children inherit these session rules. These are directory-boundary allowances, separate from the undeployed CRUD operation policy.
- Added the explicitly assigned `skillrepo/ps/genweeklyreport/*` audit scope before starting the fresh reviewers; no audit-target edits were authorized or made.

## Council
- Fixed all four independently accepted findings: parent-permission inheritance, preserved partial/round findings, running-child continuation handles, and router final-tester rejection.
- Node fixtures: 125 council passes (+1 existing TODO), 13 capability passes. Five-file API checker: zero owned diagnostics; full/transitive checking remains unverified.
- R patch and workflow synchronized with `deltav11`; R SHA-256 `95c288b9c9e5f30d896d1e0d47a2f35267033f025628da30887dc8901dc9a654`, 152,030 bytes.
- Strict diff reconstruction and the one-upstream-hook audit passed. No new git-apply or deployment check.

## Permission source patch
- User selected a separate source patch. `patches/HarnessPermissions.patch` and its manifest are synchronized with `deltav11`; the one-hook personalization bundle and its automatic workflow remain separate.
- 33 files, 125,437 bytes; SHA-256 `ae95dc6de5c2bc26055bac537a720c51ebc0d90d4ae78b3456619e6a000b3bd5`. Based on reconstructed source revision `eedb7fb3d0b984a606812adee6eb25d23415882f`.
- Durable grants now publish canonical `SessionEvent.Permissions` with a transaction/sequence check; they do not directly update the projected session table.
- Fixed request API forwarding, typed invalid-policy responses, directory classification, recursive-search coverage, and UI type mismatches.
- MCP configuration entry point: `experimental.mcp_selection: "MCP:=playwright"`. It compiles into existing configured-server availability without changing native-tool permissions.
- Node evidence: 15 CRUD helper/service tests, 4 actual MCP config-registration fixtures, 2 web lifecycle tests, and 9 shared parser/MCP-marker fixtures passed.
- Official client generator ran under Node; 11 generated files checked and 4 substantively changed files copied verbatim. Generated clients were not hand-edited.
- Focused source API checking reports zero diagnostics in selected core/schema/protocol/server/web and TUI files. Full/transitive typechecking is not certified.

## Original audit completed
- Two fresh independent Terra reviewers and one Astra reviewer submitted to a separate fresh Sol judge/tester.
- Actual Python reproduced timezone loss/misdating and the Markdown issue-number collision. Stale XLSX template content is source-backed; runtime validation is blocked by missing `openpyxl`.
- Judge: 17 tests, 15 passed, 2 skipped. Defect assertions reproduce bugs; they do not certify the report generator as correct.
- See `GENWEEKLYREPORT_AUDIT_20261112.md`.

## Verification limits
- No deployment, canonical Bun check, native SQLite/restart test, real tool-side-effect E2E, browser rendering, or strobe benchmark.
- Strict patch parsing and forward/reverse reconstruction passed. No new git-apply check; git was unavailable.
- Path containment is lexical, not a symlink or operating-system sandbox.

Evidence: `C:/Users/o/AppData/Local/Temp/opencode/council-modes-20261112/`.
Detailed preserved history: `../deltav11/CLAUDE_NOTES.md`.
No Bun, builds, restarts, commits, pushes, CI, or provider probes were run.
