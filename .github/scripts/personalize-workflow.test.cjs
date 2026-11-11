'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

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
