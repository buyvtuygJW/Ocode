#!/usr/bin/env bash
set -euo pipefail

final_patch_file() {
  echo "../patches/FinalPERSONALIZE.patch"
}

apply_custom_git_patches() {
  PATCH="$(final_patch_file)"
  echo "Applying final personalize patch: $PATCH"
  if ! node ../.github/scripts/check-personalize-hooks.cjs --patches ../patches; then
    echo "ERROR: mandatory base/permissions verification failed."
    return 20
  fi
  if [ ! -f "$PATCH" ]; then
    echo "ERROR: Missing patch: $PATCH"
    return 20
  fi
  # Apply shipped bytes exactly; never synthesize a merge or rewrite whitespace.
  if git apply --index --whitespace=nowarn "$PATCH"; then
    echo "Patch applied cleanly: $PATCH"
  else
    echo "ERROR: mandatory base/permissions patch conflicted or failed: $PATCH"
    git status --short || true
    echo "Permission conflicts require review; automatic patch-side resolution is forbidden."
    return 20
  fi
  if git ls-files -u | grep -q .; then
    echo "ERROR: unmerged index entries remain:"
    git ls-files -u
    return 21
  fi
  if git grep -n -E '^(<<<<<<<|=======|>>>>>>>)' -- .; then
    echo "ERROR: conflict markers remain after patch application"
    return 22
  fi
  git status --short
  if git diff --cached --quiet; then
    echo "ERROR: final patch produced no staged changes"
    return 23
  fi
  git commit -m "ApplyFinalPERSONALIZEpatch"
  # Optional application failures are flagged; an applied stack must pass all gates.
  APPLIED_TRANSPARENCY="off"
  XPATCH="../patches/FinalPersonalizeX.patch"
  if [ -f "$XPATCH" ]; then
    echo "Attempting optional patch: $XPATCH"
    if git apply --index --whitespace=nowarn "$XPATCH" && ! git ls-files -u | grep -q .; then
      git commit -m "ApplyFinalPersonalizeX(transparency)"
      APPLIED_TRANSPARENCY="on"
      echo "Optional transparency patch applied."
    else
      echo "Optional transparency patch did NOT apply; skipping (build continues without it)."
      git reset --hard HEAD >/dev/null 2>&1 || true
    fi
  else
    echo "No optional transparency patch present."
  fi
  APPLIED_SCIENCE="off"
  SPATCH="../patches/FinalPersonalizeS.patch"
  if [ -f "$SPATCH" ]; then
    echo "Attempting optional patch: $SPATCH"
    if git apply --index --whitespace=nowarn "$SPATCH" && ! git ls-files -u | grep -q .; then
      git commit -m "ApplyFinalPersonalizeS(research-agents)"
      APPLIED_SCIENCE="on"
      echo "Optional research-agents patch applied."
    else
      echo "Optional research-agents patch did NOT apply; skipping (build continues without it)."
      git reset --hard HEAD >/dev/null 2>&1 || true
    fi
  else
    echo "No optional research-agents patch present."
  fi
  APPLIED_RSI="off"
  RPATCH="../patches/FinalPersonalizeR.patch"
  if [ -f "$RPATCH" ]; then
    echo "Attempting optional patch: $RPATCH"
    if git apply --index --whitespace=nowarn "$RPATCH" && ! git ls-files -u | grep -q .; then
      git commit -m "ApplyFinalPersonalizeR(rsi-distill-loop)"
      APPLIED_RSI="on"
      echo "Optional RSI loop patch applied."
    else
      echo "Optional RSI loop patch did NOT apply; skipping (build continues without it)."
      git reset --hard HEAD >/dev/null 2>&1 || true
    fi
  else
    echo "No optional RSI loop patch present."
  fi
  return 0
}

strip_upstream_workflows() {
  # Only opencode-src is affected, never our automation checkout.
  rm -rf .github/workflows
  return 0
}

locate_opencode_pkg() {
  if [ -f packages/opencode/package.json ]; then
    echo "packages/opencode"
  elif [ -f packages/cli/package.json ]; then
    echo "packages/cli"
  else
    return 1
  fi
}

dist_prefix_for() {
  case "$1" in
    packages/cli) echo "cli" ;;
    *) echo "opencode" ;;
  esac
}

resolve_opencode_version() {
  # Detached builds otherwise stamp 0.0.0, which fails the upstream free-tier gate.
  local v="${OPENCODE_VERSION:-}"
  if [ -z "$v" ]; then
    v="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
           "$(locate_opencode_pkg 2>/dev/null || echo packages/opencode)/package.json" 2>/dev/null | head -1 || true)"
  fi
  case "$v" in
    ''|0.0.0*)
      echo "package.json version unusable ('${v:-<empty>}'), asking npm..."
      v="$(curl -fsSL --max-time 20 https://registry.npmjs.org/opencode-ai/latest 2>/dev/null \
           | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1 || true)"
      ;;
  esac
  if [[ ! "$v" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)([.-].*)?$ ]]; then
    echo "ERROR: could not resolve a real upstream version (got '${v:-<empty>}')"
    echo "Refusing to build: a 0.0.0 binary is locked out of the free tier."
    return 1
  fi
  local major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}"
  if [ "$major" -lt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -lt 18 ]; }; then
    echo "ERROR: resolved version $v is below the 1.18.0 free-tier floor"
    return 1
  fi
  export OPENCODE_VERSION="$v"
  export OPENCODE_CHANNEL="latest"
  echo "Build version: OPENCODE_VERSION=$OPENCODE_VERSION OPENCODE_CHANNEL=$OPENCODE_CHANNEL"
  return 0
}

run_patch_tests() {
  # Check the real build-adapter caller before Bun transpilation.
  if ! (cd packages/cli && bun run typecheck:tsc); then
    echo "ERROR: CLI/build-adapter typecheck FAILED -- refusing to build this ref"
    return 1
  fi
  local tests=() f found
  local required=(
    packages/core/test/session-context-decay.test.ts
    packages/core/test/session/content-guards.test.ts
    packages/core/test/session-model-request-hooks.test.ts
    packages/core/test/session-title.test.ts
    packages/core/test/permission.test.ts
    packages/core/test/permission/personalize.integration.test.ts
    packages/core/test/tool-patch.test.ts
    packages/core/test/patch.test.ts
    packages/core/test/file-access.test.ts
    packages/core/test/machine-path.test.ts
    packages/core/test/tool-patch-target-environment.test.ts
    packages/core/test/personalize-plugin-registration.test.ts
    packages/core/test/personalize-repository-cache.test.ts
  )
  if [ "${APPLIED_RSI:-off}" = "on" ]; then
    required+=(packages/core/test/personalize-legacy.test.ts)
  fi
  if [ "${APPLIED_SCIENCE:-off}" = "on" ]; then
    required+=(packages/core/test/personalize-science-registration.test.ts)
  fi
  for f in "${required[@]}"; do
    if [ -f "$f" ]; then
      tests+=("$f")
    else
      found="$(git ls-files "*/$(basename "$f")" | head -1 || true)"
      if [ -n "$found" ]; then
        tests+=("$found")
      else
        echo "ERROR: patched test file missing from tree: $(basename "$f")"
        return 1
      fi
    fi
  done
  # Upstream's bunfig forbids running tests from the repository root.
  local pkgdir="${tests[0]%%/test/*}"
  [ "$pkgdir" = "${tests[0]}" ] && pkgdir="."
  local rel=() f2
  for f2 in "${tests[@]}"; do rel+=("${f2#"$pkgdir"/}"); done
  echo "Running patched unit tests (cwd $pkgdir): ${rel[*]}"
  if ! (cd "$pkgdir" && bun run script/test.ts "${rel[@]}"); then
    echo "ERROR: patched unit tests FAILED -- refusing to build this ref"
    return 1
  fi
  if [ ! -f packages/server/test/personalize-permission-policy.test.ts ]; then
    echo "ERROR: mandatory permission HTTP regression missing"
    return 1
  fi
  if ! (cd packages/server && bun run ../core/script/test.ts test/personalize-permission-policy.test.ts); then
    echo "ERROR: permission HTTP regression FAILED -- refusing to build this ref"
    return 1
  fi
  if [ ! -f packages/tui/test/personalize-mini-permission.test.ts ] || [ ! -f packages/tui/test/personalize-permission-render.test.tsx ]; then
    echo "ERROR: mandatory rendered/Mini permission regression missing"
    return 1
  fi
  if ! (cd packages/tui && bun test test/personalize-mini-permission.test.ts test/personalize-permission-render.test.tsx test/mini/permission.shared.test.ts test/util/permission.test.ts); then
    echo "ERROR: rendered/Mini permission regression FAILED -- refusing to build this ref"
    return 1
  fi
  local permission_tests=(
    packages/core/test/permission/session-grant.test.mjs
    packages/core/test/permission/service.node.test.mjs
    packages/core/test/config/mcp-selection.node.test.mjs
    packages/app/src/session/requests/permission-machine.node.test.mjs
  )
  for f in "${permission_tests[@]}"; do
    if [ ! -f "$f" ]; then
      echo "ERROR: mandatory permission test missing: $f"
      return 1
    fi
  done
  if [ ! -f .personalize/node-typescript.mjs ]; then
    echo "ERROR: mandatory Node source resolver missing: .personalize/node-typescript.mjs"
    return 1
  fi
  if ! node --import ./.personalize/node-typescript.mjs --experimental-transform-types --test "${permission_tests[@]}"; then
    echo "ERROR: mandatory permission regressions FAILED -- refusing to build this ref"
    return 1
  fi
  local owned_tests=(
    .personalize/context-decay.test.mjs
    .personalize/lifetime-effect.test.mjs
    .personalize/lifetime.test.mjs
    .personalize/session-title.test.mjs
    .personalize/permission-contract.test.mjs
    .personalize/single-executable.test.mjs
    .personalize/node-typescript.test.mjs
    .personalize/bootstrap.test.mjs
    .personalize/startup-ownership.test.mjs
    .personalize/startup-recovery.test.mjs
    .personalize/storage-diagnostic.test.mjs
    .personalize/connection-backoff.test.mjs
  )
  for f in "${owned_tests[@]}"; do
    if [ ! -f "$f" ]; then
      echo "ERROR: mandatory owned regression missing: $f"
      return 1
    fi
  done
  if ! (cd packages/core &&
    PERSONALIZE_EFFECT="$(node --input-type=module -e 'console.log(import.meta.resolve("effect"))')" \
      node --experimental-transform-types --test \
      ../../.personalize/context-decay.test.mjs \
      ../../.personalize/lifetime-effect.test.mjs \
      ../../.personalize/lifetime.test.mjs \
      ../../.personalize/session-title.test.mjs \
      ../../.personalize/permission-contract.test.mjs \
      ../../.personalize/single-executable.test.mjs \
      ../../.personalize/node-typescript.test.mjs \
      ../../.personalize/bootstrap.test.mjs \
      ../../.personalize/startup-ownership.test.mjs \
      ../../.personalize/startup-recovery.test.mjs \
      ../../.personalize/storage-diagnostic.test.mjs \
      ../../.personalize/connection-backoff.test.mjs); then
    echo "ERROR: lifetime/context/title regressions FAILED -- refusing to build this ref"
    return 1
  fi
  if [ "${APPLIED_RSI:-off}" = "on" ]; then
    if ! (cd packages/core && node --test ../../.personalize/subagent-capabilities.test.mjs); then
      echo "ERROR: subagent capability regressions FAILED -- refusing to build this ref"
      return 1
    fi
  fi
  if [ "${APPLIED_TRANSPARENCY:-off}" = "on" ]; then
    if [ ! -f packages/tui/test/personalize-transparency-plugin.test.tsx ]; then
      echo "ERROR: mandatory transparency plugin regression missing"
      return 1
    fi
    if ! (cd packages/tui && bun test test/personalize-transparency-plugin.test.tsx --timeout 30000); then
      echo "ERROR: transparency plugin regression FAILED -- refusing to build this ref"
      return 1
    fi
  fi
  return 0
}

run_opencode_build() {
  if ! resolve_opencode_version; then
    return 1
  fi
  local pkg prefix flag
  if ! pkg="$(locate_opencode_pkg)"; then
    echo "ERROR: no CLI package found (neither packages/opencode nor packages/cli has a package.json)"
    return 1
  fi
  prefix="$(dist_prefix_for "$pkg")"
  flag="--skip-embed-web-ui"
  [ "$pkg" = "packages/cli" ] && flag="--skip-web-ui"
  echo "CLI package dir: $pkg (dist prefix: $prefix, web-ui flag: $flag)"
  # Keep the temporary dependency repair around the build's own install too.
  if ! node .personalize/repair-photon-patch.cjs --run . bun run --cwd "$pkg" build -- "$flag"; then
    echo "opencode build failed"
    return 1
  fi
  for d in \
    windows-x64 windows-x64-baseline \
    linux-x64 linux-x64-baseline linux-arm64 \
    darwin-x64 darwin-x64-baseline darwin-arm64; do
    if [ ! -d "$pkg/dist/$prefix-$d" ]; then
      echo "missing build output: $prefix-$d"
      return 1
    fi
  done
  local bin
  bin="$(find "$pkg/dist/$prefix-linux-x64" -type f -name opencode \
         -perm -u+x 2>/dev/null | head -1 || true)"
  if [ -z "$bin" ]; then
    echo "ERROR: could not locate the linux-x64 opencode binary to verify"
    return 1
  fi
  local reported
  reported="$("$bin" --version 2>&1 | tr -d '\r' || true)"
  if ! printf '%s' "$reported" | grep -qF "$OPENCODE_VERSION"; then
    echo "ERROR: binary reports '$reported', expected it to contain $OPENCODE_VERSION"
    echo "A 0.0.0 build is locked out of the free tier -- refusing to release it."
    return 1
  fi
  echo "Binary reports: $reported"
  return 0
}

try_build() {
  local ref="$1"
  local label="$2"
  echo "TRY BUILD: $label ($ref)"
  rm -rf opencode-src
  git clone --no-checkout "$UPSTREAM_REPO" opencode-src
  cd opencode-src
  if ! git fetch origin "$ref"; then
    echo "ERROR: failed to fetch upstream ref: $ref"
    cd ..
    return 10
  fi
  if ! git checkout --detach FETCH_HEAD; then
    echo "ERROR: failed to checkout FETCH_HEAD"
    cd ..
    return 11
  fi
  UPSTREAM_SHA="$(git rev-parse HEAD)"
  echo "Checked out upstream SHA: $UPSTREAM_SHA"
  # A historical success is not compatibility evidence for today's patches.
  if ! node ../.github/scripts/check-personalize-hooks.cjs --patches ../patches --upstream .; then
    echo "ERROR: personalization isolation check failed ($label: $UPSTREAM_SHA)"
    cd ..
    return 12
  fi
  git config user.name "claudedbuildbot"
  git config user.email "claudedbuildbot@example.local"
  strip_upstream_workflows
  if ! apply_custom_git_patches; then
    echo "ERROR: custom patch application failed"
    cd ..
    return 20
  fi
  # User-approved session naming; never change it without explicit approval.
  if ! git apply --index --whitespace=nowarn ../patches/SessionTitleNaming.patch; then
    echo "ERROR: session title patch failed; refusing to build"
    cd ..
    return 20
  fi
  if git grep -n -E '^(<<<<<<<|=======|>>>>>>>)' -- .; then
    echo "ERROR: unresolved conflict markers before build"
    cd ..
    return 23
  fi
  git log --oneline -12
  if ! node .personalize/repair-photon-patch.cjs --run . bun install; then
    echo "ERROR: bun install failed"
    cd ..
    return 30
  fi
  if ! { run_patch_tests && run_opencode_build; }; then
    # Reject the ref, never erase unrelated features to pass.
    echo "ERROR: patched tests/build failed (transparency=${APPLIED_TRANSPARENCY:-off}, science=${APPLIED_SCIENCE:-off}, rsi=${APPLIED_RSI:-off})."
    cd ..
    return 40
  fi
  cd ..
  echo "built_ref=$ref" >> "$GITHUB_OUTPUT"
  echo "built_sha=$UPSTREAM_SHA" >> "$GITHUB_OUTPUT"
  echo "built_label=$label" >> "$GITHUB_OUTPUT"
  echo "transparency=${APPLIED_TRANSPARENCY:-off}" >> "$GITHUB_OUTPUT"
  echo "science=${APPLIED_SCIENCE:-off}" >> "$GITHUB_OUTPUT"
  echo "rsi=${APPLIED_RSI:-off}" >> "$GITHUB_OUTPUT"
  return 0
}

# Safe to source for verification; only main starts a clone/build.
main() {
  local latest_ref="$UPSTREAM_REF"
  local last_success="${LAST_SUCCESS:-}"
  if try_build "$latest_ref" "latest"; then
    echo "Latest upstream build succeeded."
    return 0
  fi
  echo "Latest upstream build FAILED."
  if [ -z "$last_success" ]; then
    echo "No last successful upstream ref exists. Cannot fallback."
    return 1
  fi
  if ! node .github/scripts/release-combination.cjs verify . fallback-combination.json "$(bun --version)" "$last_success"; then
    echo "No matching tested fallback for these inputs. Keeping the previous release; this build failed."
    return 1
  fi
  echo "Falling back to last successful upstream ref: $last_success"
  if try_build "$last_success" "fallback-last-success"; then
    echo "Fallback build succeeded."
    return 0
  fi
  echo "Fallback build also failed. Manual patch maintenance required."
  return 1
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
