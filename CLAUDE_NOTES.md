# Claude handoff notes — opencode auto-build repo (D:\temp)

Paste into a new Claude Code session for context. (Not using Claude auto-memory by request.)
Don't grep the whole repo — only the key files below matter.

## What this repo is
Automation repo. On weekly cron / push / manual dispatch it: clones latest upstream opencode
(`anomalyco/opencode`, branch `production`) → applies my patches → builds the CLI (TUI, all
targets, web UI skipped) → publishes a GitHub Release → force-pushes the patched tree to `dev`.
If the LATEST upstream build fails, it falls back to rebuilding the last-good SHA (no release/sync).

Key files (the ONLY things that matter):
- `patches/FinalPERSONALIZE.patch` — CORE personalization (3 TS files). MUST apply (else fallback).
- `patches/FinalPersonalizeX.patch` — OPTIONAL features (best-effort; transparency + MCP instructions).
- `.github/workflows/weekly_customautorel.yml` — the build workflow.
- `regen-personalize.ps1` — **LOCAL / EXTERNAL helper — NOT in the repo.** Untracked; never committed or
  synced to `dev` (the build force-pushes the upstream opencode-src tree to `dev`, which does not contain
  it). Keep your own copy and paste it back each session, exactly like this `CLAUDE_NOTES.md`. It does
  one-command regen of BOTH patches (2 pauses) → reset on origin/dev → commit (claudedbuildbot) → force-push.

## Patches
**Core (`FinalPERSONALIZE.patch`)** — the personalization hunks below + the #459 SANITIZE hunks
(flag/otlp/share-next, already in the patch); never any `.github/` hunks:
- `packages/opencode/src/cli/logo.ts` — custom left glyph (override of the `@opencode-ai/tui/logo` re-export).
  ⚠️ ONLY feeds the CLI banner (`UI.logo()` in `cli/ui.ts`) — NOT the interactive TUI home logo.
- `packages/opencode/src/cli/ui.ts` — custom wordmark (CLI banner only).
- `packages/tui/src/logo.ts` — **THE VISIBLE TUI HOME-SCREEN LOGO** (`logo.left` glyph). Rendered by
  `packages/tui/src/component/logo.tsx` `<Logo>` via `routes/home.tsx`, which imports `@opencode-ai/tui/logo`
  DIRECTLY — bypassing the cli/logo.ts override, so it is a SEPARATE target. Replace `left` with the symbol;
  keep `right` ("code"). The `go`/`GoLogo` mini-mark in the same file is still stock (follow-up if seen).
- `packages/opencode/src/session/prompt.ts` — role injection + identity override. Loads `role.json`
  (`loadRoleEvalConfig`; `path` already imported, only add `fs`; debug log COMMENTED; DROP the
  `isOrphanedInterruptedTool` removal) + a top-level `stripIdentity()` helper. When `assistant_system` is
  set, builds `roleAgent = {...agent, prompt: [persona, ...provider(model).map(stripIdentity)].join("\n")}`
  and passes `agent: roleAgent` to `handle.process(...)`; `system` is just `[...env, ...instructions, ...skills]`.
  - WHY IT WORKS (2026-06-29 rework): `request.ts:72` is `input.agent.prompt ? [input.agent.prompt] :
    SystemPrompt.provider(model)`. Stuffing persona+stripped-stock into `roleAgent.prompt` makes the persona
    LEAD and removes the stock identity opener for ALL models — gated (empty persona → `roleAgent === agent`
    → stock behavior). ALL in prompt.ts; `request.ts`/`system.ts` UNTOUCHED → no X-patch/MCP collision,
    `$CoreFiles` unchanged. Safe because `input.agent.prompt` is read ONLY at `request.ts:72` (other
    `input.agent.*` reads are `.name/.options/.permission`).
  - `stripIdentity(p)` = `p.replace(/^You are (?:OpenCode|opencode),[^.]*\.\s*/, "")`, EXCEPT
    `p.startsWith("You are opencode, an agent")` (beast.txt) → returned unchanged: beast's sentence-1 IS the
    agentic "keep going until resolved" instruction, not just identity. Strips anthropic/codex/default/
    trinity/kimi/gemini/gpt openers; leaves beast.
  - ROLE VOICE: persona goes in RAW (no wrapper — user owns the wording). Stock "You are opencode" is now
    stripped + persona leads, so the old "1st-person reads as the USER" drift is weak but not impossible; if
    a bare "I am a girl" still drifts, write it 2nd-person or self-frame in `role.json`. `usersystem` is
    loaded but still UNUSED (only `assistant_system` wired).
  - REGEN: a regen must reproduce 3 edits on the fresh prompt.ts at PAUSE 1 — (1) the `stripIdentity` helper
    inside the `//PATCH` block, (2) the `roleAgent` block replacing the old `roleEvalConfig`/`system`
    assembly, (3) `agent: roleAgent` in the `handle.process({...})` call. `$CoreFiles` unchanged (prompt.ts only).

**Optional (`FinalPersonalizeX.patch`)** — 5 files, two features, applied best-effort as ONE unit:
- Transparency (PR #5657): `packages/tui/src/context/theme.tsx` (transparent flag, kv `theme_transparent`,
  `values()` → `RGBA(0,0,0,0)` bg, `toggleTransparent()`) + `packages/tui/src/app.tsx` ("Toggle
  transparency" System palette command).
- MCP server instructions (PR #7334): `packages/opencode/src/mcp/index.ts` (`serverInstructions` state +
  getter, `getInstructions()` from clients), `packages/opencode/src/session/llm.ts` (wire `MCP.Service`
  into the LLM layer), `packages/opencode/src/session/llm/request.ts` (append connected servers'
  instructions as `<mcp-server name="…"><![CDATA[…]]></mcp-server>` to the system prompt). No test hunks.
- TRADEOFF: both features are in ONE patch → all-or-nothing. If EITHER conflicts on upstream drift, the
  whole X-patch skips (both lost) + the release warns. Split into two best-effort patches if that bites.

## Workflow behavior (best-effort + safety nets)
1. Core patch via `git apply --3way` + auto-resolve "take patch side"; can't apply → fall back to last-good.
2. X-patch best-effort: clean `--3way` → committed; conflict → `reset --hard` skip + build continues.
3. NEW: if the build (compile) FAILS while the X-patch was applied → drop the X commit (`reset --hard HEAD~1`)
   and retry the build WITHOUT it. So a bad optional patch never blocks the build.
4. On skip/drop → release notes carry `WARNING: … FinalPersonalizeX.patch … skipped`.
5. `HUSKY=0` (no pre-push typecheck), `--skip-embed-web-ui` (TUI only), upstream `.github/workflows` rm'd,
   committer = `claudedbuildbot`.

## CRITICAL gotcha — D:\temp is a STALE snapshot vs production
Production extracted the TUI into `@opencode-ai/tui` (`packages/tui/src/{context/theme.tsx,app.tsx}`).
A stale `D:\temp` may still show the old `packages/opencode/src/cli/cmd/tui/…`. ALWAYS generate patches
against freshly-downloaded production files (the regen script does). Other moved bits will 404 on download
→ update the file lists in `regen-personalize.ps1`. The home-screen LOGO moved exactly this way: it now
lives in `packages/tui/src/logo.ts` (see Core patch list), NOT the `cli/logo.ts` override.

## Regen (one command, two pauses)
> NOTE: `regen-personalize.ps1` AND this `CLAUDE_NOTES.md` are **external/local-only files** — neither is
> tracked in the repo or present on `dev` (each weekly build overwrites `dev` with the upstream tree, which
> contains neither). A fresh Claude session starts WITHOUT them; paste them in (or ask Claude to regenerate
> the script from this section).
`D:\temp\regen-personalize.ps1` — pulls fresh production copies of all patch-target files, opens %TEMP%\ocode-patchgen,
then: **PAUSE 1** edit CORE (cli/logo, cli/ui, **tui/logo**, prompt) → FinalPERSONALIZE.patch (mandatory); **PAUSE 2** edit the X
files (theme/app/mcp/llm/request) → FinalPersonalizeX.patch (best-effort). Validates + `git apply --3way --check`
each (core fatal, X warns), resets D:\temp to origin/dev, commits as claudedbuildbot, force-pushes. Skip a
pause (just ENTER) to leave that patch unchanged. Edit `$CoreFiles`/`$XFiles` if targets move.
**`$CoreFiles` MUST include `packages/tui/src/logo.ts`** (added 2026-06-22) or a regen DROPS the home-logo hunk.

## Environment
- `git` NOT on PATH → `z:\PortableGit\cmd\git.exe` with `-c safe.directory=D:/temp`.
- `core.autocrlf=true`: working tree CRLF, commits normalize to LF (CI gets LF). `git diff` patches are LF — fine.
- Sandbox blocks my `Remove-Item` when the command also mentions `D:\temp` (false positive) — use fresh scratch names.
  (User-run scripts are NOT affected by that sandbox guard.)
- No real Python / YAML linter locally (the `python` alias is the MS-Store stub).

## Last change (2026-06-29)
- FinalPERSONALIZE.patch prompt.ts hunk REWORKED: persona now LEADS the system prompt and the stock provider
  identity opener is STRIPPED (gated on persona set) via a synthesized `roleAgent.prompt` routed through
  `request.ts:72` — entirely in prompt.ts (request.ts/system.ts untouched → no X-patch collision, `$CoreFiles`
  unchanged). New `stripIdentity()` helper (beast.txt exempt — its sentence-1 is the agentic "keep going"
  instruction). Replaces the earlier "persona at `system[0]`, stock identity kept" approach.
  Validated by a full `git apply` round-trip vs reconstructed clean upstream (reverse → forward `--check` →
  reapply → `-R --check`, all exit 0). NOT locally typecheck-verified (no bun/node_modules in this snapshot) —
  the build compile is the gate; shapes hand-checked (`Agent.Info` has `prompt`; `SystemPrompt.provider`
  returns `string[]`). Hand-edited the .patch directly (NOT via regen) + matching working-tree edit; staged in
  D:\tmp but NOT committed/pushed. A future regen must reproduce the 3 prompt.ts edits (see Patches → prompt.ts → REGEN).

## Previous change (2026-06-22)
- `73b928642b` (claudedbuildbot): FinalPERSONALIZE.patch += a `packages/tui/src/logo.ts` hunk — the VISIBLE
  TUI home-screen logo (`logo.left` → custom symbol; `right` "code" kept). cli/logo.ts + cli/ui.ts only ever
  changed the CLI banner; the home screen (`component/logo.tsx` `<Logo>` ← `home.tsx`) reads
  `@opencode-ai/tui/logo` directly, so it needed its own hunk. Verified via node render preview (symbol+code)
  and `git apply -R --check` of both the isolated hunk and the full patch (all 7 hunks parse + match the
  applied tree). Force-pushed to dev, clobbering an in-flight build `be85dc259391bda46b79c54f9f93ceb25f6c23d5`
  (upstream `7d204b5b57`, no tui hunk — recoverable SHA); the push re-triggers a build from LATEST upstream +
  this patch. ⚠️ Add `packages/tui/src/logo.ts` to `$CoreFiles` in regen-personalize.ps1 or the next regen
  DROPS this hunk. `go`/`GoLogo` mini-mark still stock.

## Previous change (2026-06-21)
- `b79ef2d91` (claudedbuildbot): one-lined the two MCP `getInstructions` blocks in the X-patch (cosmetic).
- `ffe3a4fe9`: X-patch += MCP instructions (#7334) combined with transparency; workflow gained
  drop-optional-and-retry on build failure. **CONFIRMED green** — that build's synced tree had
  `ApplyFinalPersonalizeX` ON TOP of the core commit, so the combined X-patch applied AND compiled
  (MCP + transparency both build + ship; the retry did NOT drop it). Only *live* MCP runtime behavior is
  untested — if a binary misbehaves around MCP/LLM, drop the mcp hunks from FinalPersonalizeX.patch.
- Also confirmed green+synced: transparency-only X-patch, core regen, HUSKY=0, --skip-embed-web-ui,
  claudedbuildbot, strip_upstream_workflows.
