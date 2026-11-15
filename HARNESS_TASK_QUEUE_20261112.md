# Harness work queue — 2026-11-12

## P0 — External-directory CRUD permission grants
- User reports repeated prompts for each read of `D:\Prog\own\rust\allsrccollec\aimonitor\v3`, showing pattern `D:/Prog/own/rust/allsrccollec/aimonitor/v3/*`.
- Investigate operation classification, Windows path/pattern matching, and permission grant lifetime.
- Expose distinct Read/Create/Update/Delete selections with one-request or session lifetime.
- A read grant must not authorize mutation; a session grant must cover matching subsequent reads without repeated prompts.
- Preserve unrelated permission rules. No blanket external-directory allow.
- Status: source implementation and offline integration checks complete; see `HARNESS_PERMISSION_SPEC_20261112.md`. Not deployed. User approved separate `patches/HarnessPermissions.patch`, preserving the one-hook personalization bundle.
- Live worker-access correction completed: existing session API grants for `finalsnap/*`, `deltav11/*`, and the approved scratch directory were applied and read back on the parent plus 19 descendants. This does not implement the new operation-specific policy or grant arbitrary external paths.
- Shared parser/MCP markers: 9 Node fixtures passed. Existing MCP config registration now consumes `experimental.mcp_selection: "MCP:=playwright"`; 4 additional fixtures pass. Native-tool permissions stay separate.
- CRUD helpers/service: 15 passing Node tests; web lifecycle: 2. Canonical durable session-permission events replace the initial draft's direct projected-table write. Recursive search cannot use a narrow grant or bypass nested denies.
- Official client generation completed under Node; 11 files checked, 4 changed files copied verbatim. Focused core/API/web/TUI checking has zero selected-file diagnostics. Full/native/browser verification remains unrun.
- Source patch synchronized in both trees, 125,437 bytes, SHA-256 `ae95dc6de5c2bc26055bac537a720c51ebc0d90d4ae78b3456619e6a000b3bd5`; strict forward/reverse reconstruction passed. It is not wired into the build workflow.

## Verified source — Council modes and delegation capability contracts
- Explicit independent/collaborative information-flow modes and a discoverable complete strategy catalog.
- Equal-tier reviewer slots, including two Terra slots plus one Astra/Sol slot; separate final judge/tester/executor.
- Independent reviewers receive no sibling answers or parent conversation history.
- Grant council access explicitly to intended reviewer profiles.
- Fail delegation before spawning when required tools are unavailable; expose effective capabilities.
- Source/fixture verification and synchronized patches; no builds, binary changes, restarts, installs, commits, pushes or CI.
- Accepted F1–F4 are fixed: inherited permission preflight, retained partial/round evidence, pending continuation handles, and selector-only router validation.
- Fresh evidence: 125 council fixtures passed (+1 existing TODO), 13 capability fixtures passed. Selected-file API checker: zero owned diagnostics, full transitive/canonical check unverified.
- R patch/workflow synchronized in both trees; R SHA-256 `95c288b9c9e5f30d896d1e0d47a2f35267033f025628da30887dc8901dc9a654`. Single-hook audit and strict diff reconstruction passed; git-apply and deployment checks remain unrun.

## Completed — Original skill design audit
- Target: `D:\Prog\own\mixed\lclagenticplatform\agenticproj_genV3\skillrepo\ps\genweeklyreport`.
- Initial fresh readers produced independent static findings but could not run a council or tests with their then-read-only tool sets. Do not call those results an executed debate or test run.
- Fresh two-Terra/one-Astra reviews were adjudicated by a separate Sol judge. Actual Python: 17 tests, 15 passed, 2 XLSX checks skipped because openpyxl is missing. See `GENWEEKLYREPORT_AUDIT_20261112.md`; the target was not modified.

## Verification exception approved by user
- Restore Prettier 3.6.2 only into `C:/Users/o/AppData/Local/Temp/opencode/council-modes-20261112/prettier` for client generation under Node.
- No repository dependency installation and no Bun/binary build.
- The generator uses the actual existing NodeFileSystem implementation through a narrow Node import bridge; no protocol/schema behavior is mocked.
