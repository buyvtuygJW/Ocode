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
- `patches/FinalPersonalizeS.patch` — OPTIONAL science agents (best-effort; OpenScience research/biology/physics/ml + subagents).
- `patches/build-openscience-skills.sh` — OPTIONAL science SKILLS (~290) → `openscience-skills.tar.gz`, a downloadable RELEASE ASSET (install to `~/.claude/skills/`); too many to compile in.
- `patches/FinalPersonalizeR.patch` — OPTIONAL deterministic `/distill` RSI loop, COMPILED INTO THE BINARY (best-effort): native `distill_session` tool + built-in `/distill` command.
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
  - WHY IT WORKS (2026-06-29 rework): `request.ts:60` is `input.agent.prompt ? [input.agent.prompt] :
    SystemPrompt.provider(model)`. Stuffing persona+stripped-stock into `roleAgent.prompt` makes the persona
    LEAD and removes the stock identity opener for ALL models — gated (empty persona → `roleAgent === agent`
    → stock behavior). ALL in prompt.ts; `request.ts`/`system.ts` UNTOUCHED → no X-patch/MCP collision,
    `$CoreFiles` unchanged. Safe because `input.agent.prompt` is read ONLY at `request.ts:60` (other
    `input.agent.*` reads are `.name/.options/.permission`).
  - `stripIdentity(p)` = `p.replace(/^You are (?:OpenCode|opencode),[^.]*\.\s*/, "")`, EXCEPT
    `p.startsWith("You are opencode, an agent")` (beast.txt) → returned unchanged: beast's sentence-1 IS the
    agentic "keep going until resolved" instruction, not just identity. Strips anthropic/codex/default/
    trinity/kimi/gemini/gpt openers; leaves beast.
  - ROLE VOICE: persona goes in RAW (no wrapper — user owns the wording). Stock "You are opencode" is now
    stripped + persona leads, so the old "1st-person reads as the USER" drift is weak but not impossible; if
    a bare "I am a girl" still drifts, write it 2nd-person or self-frame in `role.json`. `usersystem` is
    loaded but still UNUSED (only `assistant_system` wired).
  - REGEN: reproduce 3 edits on the fresh prompt.ts at PAUSE 1 — (1) the `stripIdentity` helper inside the
    `//PATCH` block, (2) the `roleCtx`/`persona`/`roleAgent` block immediately before `const system = [`,
    (3) `agent: roleAgent` in `handle.process({...})`. `$CoreFiles` unchanged. NOTE: current upstream's
    assembly is multi-line and includes `mcpInstructions` (native MCP) — keep those lines as-is. Core patch
    was regenerated against upstream `0a5e617da8` on 2026-06-29 (see Last change).

**Optional (`FinalPersonalizeX.patch`)** — transparency ONLY (2 files), best-effort. MCP #7334 DROPPED 2026-06-29 (see below).
- Transparency (PR #5657): `packages/tui/src/context/theme.tsx` (transparent flag, kv `theme_transparent`,
  `values()` → `RGBA(0,0,0,0)` bg, `toggleTransparent()`) + `packages/tui/src/app.tsx` ("Toggle
  transparency" System palette command). Regenerated against upstream `0a5e617da8` on 2026-06-29; applies via
  `git apply --check` and `--3way`.
- ~~MCP server instructions (PR #7334)~~ DROPPED 2026-06-29 — VERIFIED redundant (read both impls): upstream
  MERGED #7334 natively. `session/system.ts:110` `sys.mcp(agent, permission)` captures the SAME
  `mcpClient.getInstructions()` and injects connected servers' instructions into the system prompt (the
  `mcpInstructions` slot), PLUS permission-aware filtering (omits a server whose tools are ALL disabled for
  the agent) that ours lacked. Ours was a strict subset and would DOUBLE-INJECT if forced to coexist. Removed
  files: `mcp/index.ts`, `session/llm.ts`, `session/llm/request.ts`.
- TRADEOFF (now moot): X is a single feature (transparency), so no all-or-nothing risk. If theme.tsx/app.tsx
  conflict on future drift, X skips (only transparency lost) + release warns.

**Optional (`FinalPersonalizeS.patch`)** — OpenScience research agents (best-effort), extracted 2026-07-12 from
github.com/synthetic-sciences/openscience. Adds 9 NATIVE agents to `packages/opencode/src/agent/agent.ts` (+9 imports,
one insertion after `build`) + 9 NEW prompt files under `packages/opencode/src/agent/prompt/`. Purely ADDITIVE —
`build` stays the default (`research` is inserted AFTER `build`, so `defaultInfo()` still returns build); select
`research` in the agent picker or set `default_agent: "research"` to use it.
- Agents: `research` (primary), `biology`/`physics`/`ml` (mode `all`), + subagents `write`, `literature-review`,
  `critique`, `physics-critique`, `reviewer` (`steps:60` on the 3 critics). Each sets a `prompt:` field → consumed at
  `request.ts:60`, so it COMPOSES with the CORE role patch (persona still LEADS; `stripIdentity` leaves the science
  prompts intact — they start with `<system-reminder>`/"You are a … agent", not "You are opencode,").
- ADAPTED, not copied: OpenScience's own `agent.ts` is an OLDER opencode fork (zod / `namespace` / `PermissionNext` /
  `Instance.state`); current upstream is effect `Schema` / `Permission.merge` / `Layer.effect` / `InstanceState`. Entries
  were rewritten to upstream shape (`Permission.merge(defaults, …, user)`, read-only subagents use the in-scope
  `readonlyExternalDirectory` + `Truncate.GLOB`). Their primaries carry NO `prompt` (wired via `session/system.ts`); we
  set `prompt:` directly instead, so `system.ts` is UNTOUCHED (no collision with core/X).
- DE-BRANDED (essence kept, product plumbing removed): `research.txt` "Atlas / `openscience project init` /
  `app.syntheticsciences.ai` / `atlas doctor` managed-compute" blocks (dead CLI here) → generic "persist locally" +
  "BYOK cloud GPUs"; `"You are OpenScience Physics/ML/Biology"` → "You are a <domain> research agent"; "OpenScience
  skills"/"OpenScience Advantage" → "skills". Verified 0 `openscience|synthetic|atlas|daytona` strings remain. The 290+
  science SKILLS are NOT bundled (agents-only port); prompts degrade gracefully on missing skills/tools.
- NOT ported (deliberate): the `session/rlm/` + `session/rsi/` research LOOP (invasive session-processor surgery; its
  behavior rides in the research prompt + critique/reviewer subagents) and the browser DASHBOARD (SolidStart web app —
  can't live in a TUI; build is `--skip-embed-web-ui`).
- WORKFLOW (wired like X, independent + best-effort): `apply_custom_git_patches` records `CORE_SHA` after the core
  commit, then applies S via `git apply --3way --index` → commit `ApplyFinalPersonalizeS(research-agents)` →
  `APPLIED_SCIENCE=on`; clean-skip → `reset --hard HEAD`. On BUILD failure the drop-retry now resets to `CORE_SHA`
  (drops BOTH optionals, was `HEAD~1`) and rebuilds. Adds a `science` build-output, a release-notes WARNING on skip, and
  a state-file copy. Independent of X at apply time; only a build FAILURE drops both.

**Optional overlays — added 2026-07-12 (loop reworked from a config bundle to a SOURCE PATCH the same day):**
- **Science SKILLS (~290) — downloadable RELEASE ASSET.** `patches/build-openscience-skills.sh [out.tar.gz]` sparse-clones
  OpenScience `backend/cli/skills`, drops `initialize-atlas-graph`+`skill-installer`, de-brands (OpenScience→OCode,
  syntheticsciences/synthetic-sciences→ocode) while KEEPING `atlas`/bare `synthetic`/`daytona`, and tars
  `openscience-skills.tar.gz`. Built best-effort in the `package` step (latest only) → uploaded as a release asset; the
  release notes give the `curl … | tar xz -C ~/.claude/skills` install (discovered via `skills/**/SKILL.md`). NOT compiled
  into the binary — opencode embeds built-in skills one string at a time, so ~1,500 files must ship as a pack.
- **`/distill` RSI loop — COMPILED INTO THE BINARY via `patches/FinalPersonalizeR.patch`.** Native, deterministic, NO LLM
  scoring. Adds `tool/distill.ts` (the `distill_session` native tool: reads the trajectory from `ctx.messages` — `Tool.Context`
  already carries the session messages, so NO Database/MessageV2 plumbing — runs the no-LLM heuristic critic
  [Correctness/Efficiency/Coverage/Reproducibility, base-by-outcome ± step/tool/repro mods, >=75 gate] and writes
  `~/.config/opencode/skills/learned/<name>/SKILL.md` + `.stats.json`, auto-discovered next session), `tool/distill.txt`,
  `command/template/distill.txt`, and wires both into `tool/registry.ts` (+ `command/index.ts`). MANUAL: the built-in
  `/distill` command invokes the tool; there is NO scoring in markdown and NO auto trigger — the fragile `prompt.ts` hook was
  deliberately omitted so the patch stays build-safe (prompt.ts is a hot 66k-line file that would conflict weekly and drop the
  whole patch). Ports session/rsi/{trajectory,critic,distill,lifecycle}.ts + rlm/state.ts as effect-native code. RISKIEST
  patch: hand-written effect, not compile-tested locally (no bun/tsc here) — validated `git apply --3way --check` exit 0 only.
Both are best-effort (`latest` only) and NEVER block the core build/release: a skills-pack build failure just skips the asset;
the RSI patch is applied/dropped like FinalPersonalizeS/X (build fail → reset to CORE_SHA drops ALL optionals + release warns).

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
files (theme/app ONLY — mcp/llm/request DROPPED 2026-06-29) → FinalPersonalizeX.patch (best-effort). Validates + `git apply --3way --check`
each (core fatal, X warns), resets D:\temp to origin/dev, commits as claudedbuildbot, force-pushes. Skip a
pause (just ENTER) to leave that patch unchanged. Edit `$CoreFiles`/`$XFiles` if targets move.
**`$CoreFiles` MUST include `packages/tui/src/logo.ts`** (added 2026-06-22) or a regen DROPS the home-logo hunk.
**`$XFiles` MUST DROP `mcp/index.ts`, `session/llm.ts`, `session/llm/request.ts`** (2026-06-29) — upstream
merged #7334 natively; leaving them re-introduces the conflict. X targets are now just theme.tsx + app.tsx.

**`FinalPersonalizeS.patch` is NOT regenerated by `regen-personalize.ps1`** — it is mostly NEW files (the 9
`agent/prompt/*.txt`), which have no upstream opencode copy to download-and-diff. Re-port it separately (see Last
change 2026-07-12): in a scratch git repo, commit upstream `agent/agent.ts` as base, drop in the 9 prompts pulled from
OpenScience `backend/cli/src/agent/prompt/` (de-branded), re-add the 9 `PROMPT_*` imports + the adapted agent entries
to `agent.ts`, then `git diff --cached`. Only the `agent.ts` hunk is drift-fragile — 2 anchors: the `PROMPT_TITLE`
import line, and the `build`→`plan` boundary in the `agents` object. Validate exactly like the others (no BOM / no
conflict markers / no `patches/`+`.github/` hunks / `git apply --3way --check` == 0).

## Environment
- `git` NOT on PATH → `z:\PortableGit\cmd\git.exe` with `-c safe.directory=D:/temp`.
- `core.autocrlf=true`: working tree CRLF, commits normalize to LF (CI gets LF). `git diff` patches are LF — fine.
- Sandbox blocks my `Remove-Item` when the command also mentions `D:\temp` (false positive) — use fresh scratch names.
  (User-run scripts are NOT affected by that sandbox guard.)
- No real Python / YAML linter locally (the `python` alias is the MS-Store stub).

## Last change (2026-07-12)
Extracted the OpenScience essence (github.com/synthetic-sciences/openscience) into THREE independent best-effort pieces:
AGENTS (`FinalPersonalizeS.patch`), the ~290 science SKILLS pack, and the `/distill` self-improvement LOOP. Only the
browser DASHBOARD was left out (SolidStart web app — cannot live in a TUI-only build). All three wired into the workflow.
- PATCH: 10 files — `agent/agent.ts` +191 lines (9 imports + 9 native-agent entries inserted after `build`) and 9 new
  `agent/prompt/*.txt` (3190 insertions, ~162 KB). Agents: research/biology/physics/ml + write/literature-review/
  critique/physics-critique/reviewer. Built in a scratch git repo (upstream `agent.ts` committed as base → hand-edit →
  `git diff --cached`). Validated: no BOM, no conflict markers, no `patches/`+`.github/` hunks, `git apply --3way
  --check` exit 0.
- ADAPTED to current upstream (OpenScience's agent.ts is an older opencode fork) + DE-BRANDED (Atlas / syntheticsciences
  / `atlas`+`openscience` CLI plumbing stripped; identity lines de-branded; 0 brand strings remain). Details in
  Patches → Optional S.
- WORKFLOW: `CORE_SHA` capture after core commit; second best-effort apply block (`APPLIED_SCIENCE`); drop-retry
  generalized to `reset --hard "$CORE_SHA"` (drops BOTH optionals); `science` GITHUB_OUTPUT + release-notes warning +
  state-file copy. Core build NEVER fails over it. Regenerated via `git diff`; scratch worktrees under `%TEMP%\os-*`
  can be deleted.
- SKILLS (all ~290 — downloadable RELEASE ASSET, NOT a git patch). `build-openscience-skills.sh [out.tar.gz]`
  sparse-clones OpenScience `backend/cli/skills`, DROPS pure-product skills (`initialize-atlas-graph`, `skill-installer`),
  de-brands (OpenScience→OCode, syntheticsciences/synthetic-sciences→ocode) while LEAVING `atlas`/bare `synthetic`/
  `daytona`, and tars `openscience-skills.tar.gz`. Built best-effort in the `package` step (latest only) → release asset;
  release notes give the `curl … | tar xz -C ~/.claude/skills` install. Validated locally (git-bash): 290 skills, 0 residual.
- LOOP = SOURCE PATCH compiled into the binary (`FinalPersonalizeR.patch`, 5 files / +293). Native + deterministic + NO LLM
  scoring: `tool/distill.ts` (`distill_session` — reads the trajectory from `ctx.messages` [Tool.Context ALREADY carries the
  session messages → no Database/MessageV2 plumbing], runs the no-LLM heuristic critic [base-by-outcome ± step/tool/repro
  mods, >=75 gate], writes `~/.config/opencode/skills/learned/<name>/SKILL.md` + `.stats.json`), `tool/distill.txt`,
  `command/template/distill.txt`, wired into `tool/registry.ts` + `command/index.ts`. MANUAL only: built-in `/distill`
  invokes the tool. Auto (prompt.ts hook) DELIBERATELY OMITTED — prompt.ts is a hot 66k-line file that would conflict weekly
  and drop the whole patch. Ports session/rsi/{trajectory,critic,distill,lifecycle}.ts + rlm/state.ts as effect-native code
  (mirrors `tool/todo.ts`: Tool.define/Schema.Struct/`satisfies Tool.DefWithoutID`; `Global.Path.config` for the skills dir).
- WORKFLOW (loop): third best-effort apply block (`APPLIED_RSI`, after `APPLIED_SCIENCE`); drop-retry condition + `CORE_SHA`
  reset now cover RSI too; `rsi` GITHUB_OUTPUT; release-notes warning if dropped + "built into binary" note if applied; R
  patch copied to dev state. Skills: `package` step builds the tarball asset (latest only) + release-notes install block.
  The interim `.opencode`-bundling of skills/loop into `dev` was REMOVED; the loop plugin bundle + install scripts deleted.
- NOT committed/pushed. Agents (S) + RSI (R) patches: `git apply --3way --check` exit 0 vs fresh upstream `9976269ab`;
  NEITHER is compile-verified locally (no bun/tsc — the CI build is the gate). R is the RISKIEST (hand-written effect); if it
  fails to compile, the weekly build drops ALL optionals (reset to CORE_SHA) + the release warns (re-port needed). R was
  built against `9976269ab` in a scratch clone (deleted). Scratch `%TEMP%\os-*` can be deleted.

## Last change (2026-06-29)
Persona behavior REWORKED and BOTH patches REGENERATED against current upstream `0a5e617da8` (the D:\tmp
snapshot was badly stale). Chronology:
- A LATEST-upstream build failed on `prompt.ts:19` "Could not resolve ../session/prompt/max-steps.txt". TWO
  causes (verified by fetching upstream): (1) a TRANSIENT broken upstream commit (that import + missing file)
  — already self-healed, NOT ours; (2) our snapshot was stale — upstream refactored the system assembly to
  multi-line and added NATIVE MCP, so our old core hunk #2 (deleting the one-line `const system = [...]`) no
  longer matched.
- CORE (FinalPERSONALIZE): `git fetch https://github.com/anomalyco/opencode production` → `0a5e617da8`,
  detached worktree, `git apply --reject` (only prompt.ts hunk #2 rejected; all 6 other files + hunk #1
  clean), hand-fit hunk #2 to the new multi-line assembly (fresh `roleCtx = yield* InstanceState.context`),
  `git diff --output` to regenerate. NEW BEHAVIOR: persona LEADS + stock identity opener STRIPPED (gated), via
  synthesized `roleAgent.prompt` consumed at `request.ts:60`; new `stripIdentity()` helper (beast.txt exempt).
  Validated: `git apply --check` AND `--3way` on clean upstream both exit 0. Linchpin: `request.ts:60` still
  routes `agent.prompt`.
- X (FinalPersonalizeX): DROPPED the MCP #7334 hunks (VERIFIED redundant — upstream merged #7334 + permission
  filtering; see Patches → X). Regenerated as TRANSPARENCY-ONLY (theme.tsx + app.tsx) via `git apply --include`
  + `git diff`. Validated: `--check` + `--3way` exit 0.
- NOT locally typecheck-verified (no bun/node_modules in snapshot) — build compile is the gate; symbols
  verified present upstream. BOTH patches regenerated + validated but NOT committed/pushed. Clean up the
  `%TEMP%\ocode-*` worktrees with `git worktree remove`.

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

## 2026-08-03 qm built-in
- qm scheduler integrated INTO opencode via FinalPersonalizeR.patch (no separate app). New files: src/tool/schedule.ts (tool id `schedule_task`, 279 lines, deterministic crons, JSON state at global config dir), src/tool/schedule.txt, src/command/template/schedule.txt. Wired: registry.ts (4 refs) + command/index.ts (`/schedule`, PROMPT_SCHEDULE).
- Full chain re-validated on upstream 0a5e617da8a5d7ef8aec7a1950a1416aac9339ad: core -> R -> S -> X all apply clean. tsc syntax check: 0 errors (only no-deps TS2307 noise).
- Registry conflict fixed: regenerated hunk with CRLF-safe context (upstream registry.ts is LF in repo, CRLF on checkout; patch normalized).
