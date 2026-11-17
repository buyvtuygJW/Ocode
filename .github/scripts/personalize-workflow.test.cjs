'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { tmpdir } = require('node:os');

const workflow = readFileSync(path.join(__dirname, '../workflows/weekly_customautorel.yml'), 'utf8');
const start = workflow.indexOf('          try_build() {');
const end = workflow.indexOf('          LATEST_REF=', start);
assert.ok(start >= 0 && end > start, 'try_build must be present in workflow');
const actual = workflow.slice(start, end).replace(/^ {10}/gm, '');
const bash = process.env.PERSONALIZE_TEST_BASH || 'bash';

// Execute the workflow's real Bash function in its real `if` calling context:
// errexit is disabled there. Every external operation is replaced by a shell
// function; this cannot clone, install, invoke Bun, compile or launch a server.
function run(scenario) {
  const result = spawnSync(bash, ['--noprofile', '--norc', '-c', `
    set -euo pipefail
    export UPSTREAM_REPO=fixture GITHUB_OUTPUT=/dev/null
    scenario=${scenario}
    cd() { :; }
    rm() { :; }
    git() {
      echo "CALL git $*" >&2
      case "$1" in
        grep) return 1;;
        rev-parse) echo fixture-sha;;
      esac
    }
    node() {
      echo "CALL node $*" >&2
      if [[ "$1" == *check-personalize-hooks.cjs && "$scenario" == isolation ]]; then return 1; fi
    }
    strip_upstream_workflows() { :; }
    apply_custom_git_patches() {
      echo 'CALL apply' >&2
      APPLIED_TRANSPARENCY=on APPLIED_SCIENCE=on APPLIED_RSI=on
    }
    run_patch_tests() { echo 'CALL tests' >&2; [[ "$scenario" != tests ]]; }
    run_opencode_build() { echo 'CALL build' >&2; [[ "$scenario" != build ]]; }
    ${actual}
    if try_build fixture latest; then status=0; else status=$?; fi
    echo "RESULT $status \${APPLIED_TRANSPARENCY:-unset}/\${APPLIED_SCIENCE:-unset}/\${APPLIED_RSI:-unset}"
  `], { encoding: 'utf8', env: process.env });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return { output: result.stdout, calls: result.stderr };
}

test('a failed isolation gate rejects the ref before patching or install', () => {
  const { output, calls } = run('isolation');
  assert.match(output, /RESULT 12 unset\/unset\/unset/);
  assert.doesNotMatch(calls, /CALL (apply|tests|build)|bun install/);
});

test('one failed test cannot discard X/S/R or retry a reduced build', () => {
  const { output, calls } = run('tests');
  assert.match(output, /RESULT 40 on\/on\/on/);
  assert.equal((calls.match(/CALL tests/g) || []).length, 1);
  assert.doesNotMatch(calls, /CALL build|git reset/);
});

test('compile failure also rejects the full stack without removing features', () => {
  const { output, calls } = run('build');
  assert.match(output, /RESULT 40 on\/on\/on/);
  assert.equal((calls.match(/CALL build/g) || []).length, 1);
  assert.doesNotMatch(calls, /git reset/);
});

test('successful gates retain all applied optional features', () => {
  const { output, calls } = run('success');
  assert.match(output, /RESULT 0 on\/on\/on/);
  assert.match(calls, /CALL tests[\s\S]*CALL build/);
});

const regressionStart = workflow.indexOf('          run_patch_tests() {');
const regressionEnd = workflow.indexOf('          run_opencode_build() {', regressionStart);
assert.ok(regressionStart >= 0 && regressionEnd > regressionStart);
const regressions = workflow.slice(regressionStart, regressionEnd).replace(/^ {10}/gm, '');
const owned = ['context-decay.test.mjs', 'lifetime-effect.test.mjs', 'lifetime.test.mjs'];

function runRegressions(scenario, target = '') {
  const parent = path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'regression-gate-'));
  const files = [
    'packages/core/test/session-context-decay.test.ts',
    'packages/core/test/session/content-guards.test.ts',
    'packages/core/test/session-model-request-hooks.test.ts',
    'packages/core/test/session-title.test.ts',
    'packages/core/test/permission.test.ts',
    'packages/core/test/permission/session-grant.test.mjs',
    'packages/core/test/permission/service.node.test.mjs',
    'packages/core/test/config/mcp-selection.node.test.mjs',
    'packages/app/src/session/requests/permission-machine.node.test.mjs',
    ...owned.map((name) => `.personalize/${name}`),
  ];
  try {
    for (const file of files) {
      if (scenario === 'missing' && file === `.personalize/${target}`) continue;
      const location = path.join(directory, file);
      mkdirSync(path.dirname(location), { recursive: true });
      writeFileSync(location, '');
    }
    // Only the real gate's control flow runs. Every test runner is a stub.
    const script = `
      set -euo pipefail
      APPLIED_RSI=off
      bun() { echo "CALL bun $*" >&2; return 0; }
      node() {
        if [[ "$1" == --input-type=module ]]; then echo file:///fixture/effect.js; return 0; fi
        echo "CALL node $*" >&2
        if [[ "${scenario}" == failure && "$*" == *"${target}"* ]]; then return 1; fi
        return 0
      }
      git() { return 0; }
      ${regressions}
      if run_patch_tests; then status=0; else status=$?; fi
      echo "RESULT $status"
    `;
    const result = spawnSync(bash, ['--noprofile', '--norc', '-s'], {
      input: script, cwd: directory, encoding: 'utf8', env: process.env,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return { output: result.stdout, calls: result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const name of owned) {
  test(`missing ${name} blocks the pre-build gate`, () => {
    assert.match(runRegressions('missing', name).output, /RESULT 1/);
  });
  test(`failed ${name} blocks the pre-build gate`, () => {
    assert.match(runRegressions('failure', name).output, /RESULT 1/);
  });
}
test('the pre-build gate runs all owned regressions with Effect resolved from core', () => {
  const result = runRegressions('success');
  assert.match(result.output, /RESULT 0/);
  for (const name of owned) assert.ok(result.calls.includes(`../../.personalize/${name}`));
});
