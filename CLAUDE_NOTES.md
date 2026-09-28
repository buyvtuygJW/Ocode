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

## 2026-08-03 dev-sync push fix
- CI push to dev rejected: GITHUB_TOKEN (GitHub App) cannot create/update ANY workflow file. Two causes: (1) my earlier edit cp'd weekly_customautorel.yml into the dev tree = create, (2) upstream's tracked .github/workflows/* (beta.yml) changed at def14d96 = update.
- Fix in weekly_customautorel.yml sync job: dropped the workflow cp + its guard; added `git rm -r -q --sparse --cached --ignore-unmatch .github/workflows` + rm -rf + tracked-check guard before commit. dev now ships ZERO workflow files (deletions are allowed). Validated: YAML parses, write-tree shows 0 workflow entries, guard passes even under sparse checkout.

## 2026-08-04 council feature — BUILT into FinalPersonalizeR.patch (validated at def14d96; NOT yet committed/pushed)
Multi-model "council" = clone of the aiscouncil.com CONCEPT (not the browser app — build is TUI-only), realized via open-swarm's strategy taxonomy (matthewhand/open-swarm `cli_*` modes; marcusschiesser/open-swarm proves per-agent `model=` via LiteLLM). Checked 3 repos (user picked openswarm-ai + openswarm-os + open-swarm framework; NOT unohee).
- EXTRACTION VERDICT: the council IS the only genuinely-new capability worth pulling. **openswarm-ai/openswarm** (Electron/FastAPI/React mission-control) ≈ all redundant w/ opencode (git-worktree-per-agent, sessions, MCP, skills→~/.claude/skills, modes, permissions); only novel-for-us = unified tool-approval queue across parallel agents + per-session USD cost tracking (FUTURE, not now; ⚠ license badge MIT vs sidebar AGPL — verify before copying code). **openswarm-os/openswarm** (latent-space "resonance" wake, Sentence-BERT 384-dim, MIT) = early-alpha/unproven (17★); its resonance wake-trigger is the FUTURE "watch" idea (the un-built half of qm) but do NOT extract — a deterministic keyword/glob watch fits our no-LLM-scoring style, not embeddings.
- DELIVERY: native `council` tool + `/council` command, added to FinalPersonalizeR.patch (same OPTIONAL/best-effort tier as schedule/distill). Provider wiring MUST reuse opencode's OWN model-invocation path (fan out to N models directly) — NOT the Task tool (subagents inherit parent model, #28759). Inherits BYOK/auth, 0 new deps. Mirrors aiscouncil browser→provider.
- DON'T REINVENT (user): opencode has NO native multi-model council (OMO/ultrawork is an EXTERNAL plugin). DISTRIBUTE STEP = always direct multi-model provider fan-out (members may use DIFFERENT models) — do NOT force the Task tool (it locks to the parent model). User revised: don't bother reusing the Task tool even for same-model, "just let it be" → uniform direct fan-out. NEW code = multi-model direct-provider calls + judge/synthesize/route/vote strategy layer + config resolution (grep opencode at pinned SHA to find the real model-invocation + config-dir APIs before writing).
- NAMING (user): keep ORIGINAL open-swarm names, strip `cli_` prefix, ALIAS the aiscouncil name → same setup (simple alias map, both trigger identical layout). ALL 7 strategies in v1:
  - `fusion` / `council`            → parallel → judge → synthesize (chairman)
  - `orchestrator` / `smart-router` (`router`) → cheap router escalates / picks best model per task
  - `map` / `moa`                   → decompose → distribute → reduce (mixture of agents)
  - `debate` / `roundtable`         → N rounds, moderator resolves
  - `consensus` / `vote`            → models score each other, highest wins
  - `compare`                       → parallel side-by-side, NO synthesis (aiscouncil-only name)
  - `arena`                         → side-by-side, USER picks (TUI interactive select) (aiscouncil-only name)
- CHAIRMAN: FIXED from config. NO self-scoring (user: "morepain to maintain and test; only works in webui w/ thumbup").
- MODEL SELECTION MODES = 4: `manual` (explicit model id in config — DEFAULT/reliable) + 3 inference profiles `intelligence`/`speed`/`cost` (resolved from provider/models.dev metadata; user: "those3+1 more manual=config/naming model"). Manual is the safe default; profiles degrade if metadata absent.
- CONFIG RESOLUTION (user — per-project override + global, with fast skip):
  1. PER-PROJECT `<project>/.opencode/council.json` (exact path TBD at build): if MISSING → AUTO-CREATE as EMPTY TEMPLATE (members w/ `"model":""`). Empty `model` → local override "not configured" → SKIP instantly, fall through to global. (Template = fast skip-marker + easy-to-fill stub.)
  2. GLOBAL `~/.config/opencode/council.json` (global config dir, like the schedule store): AUTO-CREATED on manual council select when missing → SEED ONE member = the CURRENT active model, then PRINT the config path so the user goes and adds more models. (1 model = degenerate/no-meaning council MOST of the time → that's WHY we seed+print instead of silently running.)
  3. If after resolution <2 usable models → council is meaningless → the printed-path "add more models" message covers it; also OK to suggest the LEGACY task/subagent way.
- CONFIG SHAPE (draft):
  { "selection":"manual",                         // manual | intelligence | speed | cost
    "members":[ {"name":"claude","model":"anthropic/claude-opus-4-8"},   // "" = skip
                {"name":"gpt","model":"openai/gpt-5"},
                {"name":"gemini","model":"google/gemini-2.5-pro"} ],
    "chairman":"anthropic/claude-opus-4-8", "defaultStrategy":"council", "rounds":2 }
- TOOL `council` params: strategy (canonical OR alias), question, optional members/rounds/chairman overrides. Deterministic TS orchestration; only non-determinism = the model calls. Returns {perMember[], reviews[], final} (+ pending-choice for arena).
- PATCH: new files tool/council.ts, tool/council.txt, command/template/council.txt; wire registry.ts + command/index.ts (same 4-ref pattern as schedule). RISK: registry.ts is already the weekly-drift casualty — a 3rd tool grows that hunk; fold into the "optional-patch skip must FAIL LOUD" hardening.
- BUILD (2026-08-04): council folded INTO FinalPersonalizeR.patch (now 11 files / 49990 bytes; pre-council R kept as FinalPersonalizeR.patch.bak). tool/council.ts ~330 lines.
  - Structure MIRRORS proven upstream code (only tsc-safe way — sparse checkout has no node_modules, so tsc can't type-check the deps; CI build is the gate, same tier as distill/schedule): services-in-tool = task.ts pattern (`const provider = yield* Provider.Service` at init; nested `Effect.fn` run; `execute: (a,ctx)=>run(a,ctx).pipe(Effect.orDie)`; NO `satisfies`). Model call = agent.ts pattern (`Provider.parseModel(str)` -> `provider.getModel(pID,mID)` -> `provider.getLanguage(model)` -> `generateText({temperature,messages,model:language}).then(r=>r.text)` from "ai"). fs/global = schedule.ts (`Global.Path.config`).
  - Per-member failures are CAPTURED (askSafe: catchAll+catchAllDefect -> visible "[name failed: ...]" marker) so one bad provider never dies the tool. Concurrency 4. project dir = `InstanceState.directory` (ambient InstanceRef, same as config.get); current-model seed = `provider.defaultModel()`.
  - Config: global `<Global.Path.config>/council.json`; per-project `<InstanceState.directory>/.opencode/council.json` auto-created as blank TEMPLATE (model:"" => skipped). Resolution inline `members` arg > project > global. Nothing valid -> seed GLOBAL with current model + print path (1 model = pointless -> tells user to add more or use legacy task/subagent). Strategy alias map: fusion=council, orchestrator/smart-router=router, map=moa, roundtable=debate, vote=consensus; +compare,+arena. All 7 implemented. Chairman FIXED from config. `selection` field accepts manual|intelligence|speed|cost but v1 resolves MANUAL (explicit model strings); the 3 profiles are ADVISORY/forward-compat (need models.dev metadata) — documented follow-up.
  - VALIDATED: full chain CORE->R(+council)->S->X applies at pristine def14d96 (CORE/R/S plain `git apply`, X via `--3way` = how CI applies; X plain --check drift is pre-existing, unrelated to council). council.ts esbuild transpile exit 0 (syntax OK). NOT locally compiled/typechecked (no bun/node_modules). NOT committed/pushed — push patches/FinalPersonalizeR.patch to the automation repo + re-run weekly_customautorel to ship /council. Validation clone: C:\Users\o\AppData\Local\Temp\tmp.v37auJidB4\oc (pointer in %TEMP%\vwork.txt).

## 2026-08-04 workflow: LOUD optional-patch-skip warning (build stays GREEN)
- weekly_customautorel.yml "Create or update GitHub Release" step. Optionals remain best-effort — the build NEVER fails on a skip (user: "no fail on the gh rel") — but a skip is now impossible to miss:
  1. release TITLE gets a ` -- !! OPTIONAL PATCH(ES) SKIPPED !!` suffix (WARN_SUFFIX computed from transparency/science/rsi outputs);
  2. a big H1 banner is PREPENDED to the notes (`# 🚨 OPTIONAL PATCH FAILURE` / `# ⚠️ BUILT-IN FEATURES ARE MISSING`) listing exactly which patch(es) skipped and what features are lost (built from a SKIPPED=() array; NOTES_FILE now starts with `: >` truncate, banner via `>>`, then the main heredoc switched from `cat >` to `cat >>`);
  3. the per-patch detail `> WARNING` blockquotes kept below.
- Fixed accuracy: the R detail-warning and the positive "built-in tools" section now name /schedule + /council + /distill (R bundles all three now), not just /distill.
- Validated: `npx js-yaml` parse exit 0; release-step `bash -n` OK (extracted with `${{...}}` stubbed since those are Actions expressions, not bash).

## 2026-08-04 STALE-NOTES bug fixed (release re-run kept old warning)
- SYMPTOM: after pushing R+council, CI BUILT FINE (bun run script/build.ts compiled all targets incl. council.ts, smoke tests passed → rsi=on, no NEW warning) but the release still showed the old "RSI /distill patch skipped" WARNING. Council WAS in the new binary; only the notes were stale.
- ROOT CAUSE: release tag = `patched-opencode-<SHORT_SHA>` keyed on upstream SHA. Same SHA (def14d96) as the PRIOR build (when R didn't apply → rsi=off → warning baked into notes). On re-run the release already existed, and the "release exists" branch only did `gh release upload --clobber` (replaces BINARIES) — it NEVER refreshed notes/title. So new binary + stale notes/title.
- FIX (weekly_customautorel.yml release step, exists-branch): added `gh release edit "$TAG" --title "$TITLE" --notes-file "$NOTES_FILE"` after the upload, so re-runs on an existing tag refresh title+notes (warning/banner self-corrects). Validated js-yaml parse exit 0.
- TAKEAWAY: council.ts + schedule.ts + distill.ts all COMPILE at def14d96 (first real CI compile of the rebased R — passed). No code bug. The only issue was cosmetic stale notes.

## 2026-08-04 skill-frontmatter auto-fix — folded into FinalPERSONALIZE.patch (CORE)
- SYMPTOM: Claude skills skipped at load with `.claude\skills\...\SKILL.md: Failed to parse YAML frontmatter: ... a multiline key may not be an implicit key at line 5, column 1`. skill/index.ts `add()` drops any skill whose frontmatter fails `ConfigMarkdown.parse`.
- ROOT CAUSE: core `sanitize()` (packages/core/src/config/markdown.ts) — the strict→permissive fallback already inside `parse()` (`try matter(x) catch matter(sanitize(x))`) — was too weak. Its key regex `[a-zA-Z_][a-zA-Z0-9_]*` misses hyphen keys (`allowed-tools`), and it did NOTHING for TAB indentation / unindented wrapped values / leading BOM. The reported "multiline key" error is reproduced EXACTLY by a TAB in the frontmatter (see fixture F5) → the user's Reflection SKILL.md almost certainly has a tab.
- FIX (folded into CORE per user choice — zero workflow plumbing): rewrote `sanitize()` to normalize broken frontmatter into valid YAML: strip BOM; detab (tabs illegal as YAML indent); group top-level keys (hyphen/dot allowed); any value with a colon / YAML-indicator / that wraps onto following lines → literal `|-` block scalar; real block/list values + block-scalar headers + clean quoted scalars left verbatim. Runs ONLY on the already-failed path so valid files are never touched; strict superset of the old colon-only rewrite. opencode consumes only name+description, so aggressive recovery is safe. `parse`/`parseOption` unchanged.
- DELIVERY: appended as an 8th `diff --git` section to FinalPERSONALIZE.patch (existing 7 sections byte-identical; pre-fold backup = FinalPERSONALIZE.patch.prefold.bak). CORE is mandatory → no optional-drop / warn-banner / notes changes.
- VALIDATED: full chain CORE(+markdown.ts)→X→S→R applies clean at pristine def14d96, no conflict markers; patched markdown.ts esbuild-transpiles exit 0. Unit-tested the REAL transpiled sanitize with gray-matter over 6 fixtures (colon / TAB=reported error / BOM / hyphen-key allowed-tools / valid-list-preserved+broken-desc / valid-no-harm) → 6/6 parse & recover name+description; valid files unaffected. Harness: %TEMP%\skilltest (npm i gray-matter, esbuild transpile of the real file). NOT committed/pushed — push patches/FinalPERSONALIZE.patch + re-run weekly_customautorel to ship.

## 2026-08-04 OpenAI store=false (zero-logging) — 3 sites across CORE + R (validated at def14d96; NOT committed/pushed)
- GOAL (user): default `store=false` on OpenAI API calls + research true zero-logging. store=false ONLY disables the 30-day Responses-object storage (dashboard logging + retrieval); it does NOT stop the SEPARATE 30-day abuse-monitoring retention. TRUE zero-retention = **ZDR** (Zero Data Retention — sales-gated, NOT self-serve; forces store=false org-wide AND drops the abuse logs) + a signed **DPA** for GDPR (OpenAI Ireland Ltd for EEA/Swiss, OpenAI OpCo LLC for UK; incorporates SCCs). Configure at Settings → Organization → Data controls → Data Retention. The code default is the self-serve half; ZDR/DPA is the org-level half (out of code scope — user action).
- MAIN PATH ALREADY COVERED (no edit needed): `ProviderTransform.options()` (transform.ts) hardwires `result["store"]=false` for the OpenAI family (providerID `openai` OR npm ∈ @ai-sdk/openai + github-copilot + amazon-bedrock/mantle + xai; azure too) and `smallOptions()` mirrors it → the AI-SDK streamText/generateText main chat path + native-runtime inherit it. The 3 edits below close the REMAINING gaps so store:false ships regardless of which engine/call path runs.
- 3 GAP SITES fixed:
  1. `packages/opencode/src/tool/council.ts` (my council tool → R patch) — direct `generateText({...})` bypassed ProviderTransform → added `providerOptions: { openai: { store: false } }` INLINE (single line). Edited the `+` line inside council.ts's new-file section of FinalPersonalizeR.patch → hunk line-count unchanged; the stale `index 0000000..6ae62d3` new-file blob SHA is harmless for a clean fresh-file apply (`--3way` only consults it on failure) — confirmed by clean re-apply.
  2. `packages/opencode/src/agent/agent.ts` non-OAuth `generateObject` (→ CORE) — the OAuth branch already sent `ProviderTransform.providerOptions(resolved,{instructions,store:false})` via streamObject; the else/non-OAuth `generateObject(params)` (the "generate agent config" call in the agent picker) had none → now `generateObject({ ...params, providerOptions: ProviderTransform.providerOptions(resolved,{ store:false }) })`.
  3. `packages/core/src/session/runner/model.ts` `fromCatalogModel` `@ai-sdk/openai` branch (→ CORE; core-v2 native-transport CHOKEPOINT) — injected `store:false` as a DEFAULT into `model.request.body` via immer `produce` (guarded `if draft.request.body["store"]===undefined`). This is the SINGLE construction point where a core-v2 OpenAI model binds to `OpenAIResponses.route`; `withDefaults()` lowers `request.body`→`http.body` on EVERY request, so this one edit covers the v2 runner (llm.ts:207) AND compaction (compaction.ts reuses the runner's already-resolved `model`, so it inherits it — it never set providerOptions itself) AND any future core-v2 OpenAI site. An explicit config `store` still wins. Chosen over per-call-site edits (fragile / drift-prone).
- DELIVERY: CORE gains 2 APPENDED `diff --git` sections (model.ts + agent.ts; existing 8 sections byte-identical; pre-store backup = `FinalPERSONALIZE.patch.prestore.bak`). R patch = 1 in-place line edit (council.ts:177; the pre-council `FinalPersonalizeR.patch.bak` already exists — no new backup made).
- VALIDATED: full chain CORE→X→S→R applies clean at pristine def14d96, no conflict markers; store:false present at council.ts:177 / agent.ts:629 / model.ts:146; all 3 edited files esbuild-transpile exit 0 (syntax). NOT locally compiled/typechecked (no bun/node_modules — the CI build is the gate). NOT committed/pushed — push `patches/FinalPERSONALIZE.patch` + `patches/FinalPersonalizeR.patch` + re-run weekly_customautorel to ship. Validation clone: C:\Users\o\AppData\Local\Temp\tmp.v37auJidB4\oc.
- GOTCHA (recorded): the Edit tool wrote model.ts with CRLF on this Windows harness → `git diff` showed the WHOLE file changed. Fix before diffing/appending: `tr -d '\r'` the edited file back to LF (agent.ts stayed LF; only model.ts flipped).

## 2026-08-04 R patch: extracted custom tools/commands to OWNED files (shrinks the drift-fragile hunks)
- WHY: registry.ts + command/index.ts are the weekly-drift casualties — every native tool/command GREW those hunks (registry = 4 regions x 3 lines: import / `yield*` acquire / `Effect.all` key / `builtin[]`; command/index = 3 template imports + a 27-line 3-block). New files NEVER conflict (they are `/dev/null` adds); only edits to EXISTING upstream files drift. So move the content into files we own and shrink the upstream edits to a fixed minimum.
- NEW OWNED FILES (always apply, never drift):
  - `packages/opencode/src/tool/custom.ts` — `export const builtin = Effect.gen(function*(){ ... return yield* Effect.all([Tool.init(distill), Tool.init(schedule), Tool.init(council)]) })`. Mirrors registry's own acquire+init pattern; runs in the SAME Effect context when `yield*`-ed, so DistillTool/ScheduleTool/CouncilTool deps resolve identically.
  - `packages/opencode/src/command/custom.ts` — `export const CUSTOM_COMMANDS = [{name,description,template}...]` (imports the 3 template .txt). `hints()` STAYS in index.ts (applied in the loop) to avoid a circular import.
- UPSTREAM DELTA NOW (fixed, never grows):
  - registry.ts = **2 lines**: `import * as CustomTools from "./custom"` + `...(yield* CustomTools.builtin),` inside the `builtin[]` array. Replaces the old 4 regions entirely. KEY insight: the 3 tools only ever needed to be in `builtin[]` (the enabled list) — nothing else referenced `tool.distill/schedule/council`, so the `Effect.all` record key + separate acquire were dead weight.
  - command/index.ts = 1 import + a 6-line `for (const c of CUSTOM_COMMANDS) commands[c.name] = {...}` loop. Replaces 3 imports + the 27-line 3-block. (dropped the per-command `get template(){}` getter — those templates are constants, so a plain `template: c.template` is equivalent; the getter was only needed by init/review which do `.replace("${path}",...)`.)
  - Adding a future tool/command now edits ONLY custom.ts / command/custom.ts — ZERO change to registry.ts/index.ts.
- REGENERATED R wholesale via `git diff` vs pristine def14d96 (R's target files are independent of CORE/X/S — R applies clean on bare def14d96, confirmed by `--check`). New R = 50293 bytes, 13 `diff --git` sections (was 11: + tool/custom.ts + command/custom.ts), LF / no BOM. store:false (council.ts:177) preserved. Backup = `FinalPersonalizeR.patch.preextract.bak` (50037 bytes = the prior with-store-false, old-wiring version).
- VALIDATED: full chain CORE->X->S->R applies clean at def14d96 (`git apply --3way --index --whitespace=fix`, how CI applies), no conflict markers; no stray `tool.distill/schedule/council` in registry.ts; wiring present (`CustomTools.builtin` @ registry:243, `CUSTOM_COMMANDS` loop @ index:90); all 5 touched files (custom.ts x2, registry.ts, index.ts, council.ts) esbuild-transpile exit 0. NOT locally compiled (no bun/node_modules — CI is the compile gate; the `yield*`-in-array-literal + cross-file Effect requirements are the recompile risk to watch). NOT committed/pushed — push patches/FinalPersonalizeR.patch + re-run weekly_customautorel.
- GOTCHA: the Edit/Write tools emit CRLF on this Windows harness → always `tr -d '\r'` the touched files before `git diff`/apply (else the whole file shows as changed). Verify line endings with `tr -cd '\r' | wc -c`, NOT `grep -c $'\r'` inside a `$(...)` (the latter can misfire to the total line count).

## 2026-09-20 council valid-config backfill + picker (R patch)
- council.ts now validates every resolved member/chairman via Provider.getModel(); invalid entries are
  backfilled from the CURRENT session's model (not an abstract harness config — user decision), and if
  nothing valid survives it fails LOUD printing a pick-list of models actually configured in provider
  registry. Chairman validated same path. R patch regenerated from dev tree (git diff, LF, 13 files).
- VALIDATED: full chain CORE->X->S->R git apply --3way clean on pristine def14d96 (LF scratch worktree,
  no conflict markers); applied council.ts/registry.ts byte-identical to dev HEAD. Commit 32a400637.

## 2026-09-20 CRLF patch poisoning (root cause of "patches stopped applying")
- CORE/X/S .patch files had stray CR bytes (337/87/3262) after the resync copy — context matched
  upstream but bytes didn't, so git apply failed on BOTH crlf and lf checkouts. Fixed with tr -d '\r'.
- GUARD: .gitattributes now has `patches/*.patch -text` so checkout/autocrlf can never eol-convert
  patches again (commit 66d904260). Detection gotcha: MSYS grep -c $'\r' lies (text mode strips CR);
  measure with `wc -c` minus `tr -d '\r' | wc -c`.
