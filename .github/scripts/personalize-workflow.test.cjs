'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { tmpdir } = require('node:os');

const workflow = readFileSync(path.join(__dirname, '../workflows/weekly_customautorel.yml'), 'utf8');
const buildFile = path.join(__dirname, '../workflows/build-personalize.sh');
const buildScript = readFileSync(buildFile, 'utf8');
const buildEnv = { ...process.env, PERSONALIZE_BUILD_SCRIPT: buildFile.replaceAll('\\', '/') };
const bash = process.env.PERSONALIZE_TEST_BASH || 'bash';

test('build script is external, synced, and receives the fallback ref through env', () => {
  assert.match(workflow, /LAST_SUCCESS: \$\{\{ steps\.load_state\.outputs\.last_success \}\}/);
  assert.match(workflow, /run: bash \.github\/workflows\/build-personalize\.sh\s/);
  assert.match(workflow, /cp \.\.\/\.github\/workflows\/build-personalize\.sh \.github\/workflows\/build-personalize\.sh/);
  assert.doesNotMatch(buildScript, /\$\{\{/);
  const result = spawnSync(bash, ['--noprofile', '--norc', '-n', buildFile], { encoding: 'utf8' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('two successive dev syncs retain runnable workflow helpers and their tests byte-for-byte', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'workflow-generations-'));
  const files = [
    '.github/workflows/weekly_customautorel.yml',
    '.github/workflows/build-personalize.sh',
    ...readdirSync(__dirname, { withFileTypes: true }).filter((entry) => entry.isFile())
      .map((entry) => `.github/scripts/${entry.name}`),
  ];
  const expected = new Map(files.map((file) => [file, readFileSync(path.join(__dirname, '../..', file))]));
  try {
    let source = path.join(directory, 'seed');
    for (const [file, bytes] of expected) {
      mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
      writeFileSync(path.join(source, file), bytes);
    }
    for (let generation = 1; generation <= 2; generation++) {
      const target = path.join(source, 'opencode-src');
      mkdirSync(path.join(target, '.github/workflows'), { recursive: true });
      writeFileSync(path.join(target, '.github/workflows/upstream-only.yml'), 'must be removed');
      // Execute the actual copy block from THIS generation, not a reimplementation.
      // Only Git index bookkeeping is stubbed; directory removal and copies are real.
      const current = readFileSync(path.join(source, files[0]), 'utf8');
      const start = current.indexOf('          SELF=".github/workflows/weekly_customautorel.yml"');
      const end = current.indexOf('          # Produced only after', start);
      assert.ok(start >= 0 && end > start, 'sync block missing');
      const result = spawnSync(bash, ['--noprofile', '--norc', '-s'], {
        cwd: target, encoding: 'utf8',
        input: `set -euo pipefail\ngit() { [[ "$1" == rm ]]; }\n${current.slice(start, end).replace(/^ {10}/gm, '')}`,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(existsSync(path.join(target, '.github/workflows/upstream-only.yml')), false);
      for (const [file, bytes] of expected)
        assert.deepEqual(readFileSync(path.join(target, file)), bytes, `generation ${generation}: ${file}`);
      // The copied tests must locate and execute the copied neighbor, not the seed.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
      const check = spawnSync(process.execPath, ['--test',
        '--test-name-pattern=build script is external|external entry point preserves',
        '.github/scripts/personalize-workflow.test.cjs'], { cwd: target, encoding: 'utf8', env });
      assert.ifError(check.error);
      assert.equal(check.status, 0, check.stdout + check.stderr);
      assert.match(check.stdout, /external entry point preserves fallback/);
      source = target;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('inline script scalars leave room below the Actions 21000-character expression limit', () => {
  const lines = workflow.split(/\r?\n/);
  let checked = 0;
  for (let i = 0; i < lines.length; i++) {
    const header = /^( +)(?:run|script): [|>][-+]?\s*$/.exec(lines[i]);
    if (!header) continue;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() && lines[j].search(/\S/) <= header[1].length) break;
      body.push(lines[j].slice(header[1].length + 2));
    }
    // Mixed expressions become format(...) calls. Allow for doubled quotes/
    // braces and expression arguments, not just the raw YAML scalar length.
    const text = body.join('\n');
    const upperBound = text.length * 2 + 256 + (text.match(/\$\{\{/g)?.length ?? 0) * 64;
    assert.ok(upperBound < 21000, `inline script at line ${i + 1} must move to a file`);
    checked++;
  }
  assert.ok(checked > 0, 'must inspect the workflow scripts');
});

for (const scenario of ['latest', 'missing-receipt', 'stale-receipt', 'fallback', 'fallback-fails']) {
  test(`external entry point preserves ${scenario} control flow`, () => {
    const result = spawnSync(bash, ['--noprofile', '--norc', '-s'], {
      encoding: 'utf8', env: buildEnv,
      input: `
        source "$PERSONALIZE_BUILD_SCRIPT"
        UPSTREAM_REF=production
        LAST_SUCCESS=${scenario === 'missing-receipt' ? "''" : 'previous-sha'}
        try_build() {
          echo "BUILD $1 $2" >&2
          if [[ "$2" == latest ]]; then [[ "${scenario}" == latest ]]; return; fi
          [[ "${scenario}" != fallback-fails ]]
        }
        node() { echo "VERIFY $*" >&2; [[ "${scenario}" != stale-receipt ]]; }
        bun() { echo 1.4.4; }
        main
      `,
    });
    assert.ifError(result.error);
    assert.equal(result.status, ['latest', 'fallback'].includes(scenario) ? 0 : 1, result.stderr);
    assert.match(result.stderr, /BUILD production latest/);
    if (['latest', 'missing-receipt', 'stale-receipt'].includes(scenario))
      assert.doesNotMatch(result.stderr, /BUILD previous-sha/);
    else
      assert.match(result.stderr, /VERIFY .*release-combination\.cjs verify[\s\S]*BUILD previous-sha fallback-last-success/);
    if (['latest', 'missing-receipt'].includes(scenario)) assert.doesNotMatch(result.stderr, /VERIFY/);
  });
}

// Execute the workflow's real Bash function in its real `if` calling context:
// errexit is disabled there. Every external operation is replaced by a shell
// function; this cannot clone, install, invoke Bun, compile or launch a server.
function run(scenario, label = 'latest', cwd) {
  const result = spawnSync(bash, ['--noprofile', '--norc', '-c', `
    set -euo pipefail
    source "$PERSONALIZE_BUILD_SCRIPT"
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
      if [[ "$scenario" == patches-only ]]; then
        for arg in "$@"; do
          case "$arg" in
            ../*.mjs|../*.cjs)
              if [[ ! -f "$arg" ]]; then
                command "$PERSONALIZE_TEST_NODE_EXE" "$@"
                return $?
              fi
              ;;
          esac
        done
      fi
    }
    strip_upstream_workflows() { :; }
    apply_custom_git_patches() {
      echo 'CALL apply' >&2
      APPLIED_TRANSPARENCY=on APPLIED_SCIENCE=on APPLIED_RSI=on
    }
    run_patch_tests() { echo 'CALL tests' >&2; [[ "$scenario" != tests ]]; }
    run_opencode_build() { echo 'CALL build' >&2; [[ "$scenario" != build ]]; }
    if try_build fixture ${label}; then status=0; else status=$?; fi
    echo "RESULT $status \${APPLIED_TRANSPARENCY:-unset}/\${APPLIED_SCIENCE:-unset}/\${APPLIED_RSI:-unset}"
  `], { encoding: 'utf8', cwd,
    env: { ...buildEnv, PERSONALIZE_TEST_NODE_EXE: process.execPath.replaceAll('\\', '/') } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return { output: result.stdout, calls: result.stderr };
}

test('a failed isolation gate rejects the ref before patching or install', () => {
  const { output, calls } = run('isolation');
  assert.match(output, /RESULT 12 unset\/unset\/unset/);
  assert.doesNotMatch(calls, /CALL (apply|tests|build)|bun install/);
});

test('an incompatible fallback is rejected before patching or install', () => {
  const { output, calls } = run('isolation', 'fallback');
  assert.match(output, /RESULT 12 unset\/unset\/unset/);
  assert.match(calls, /check-personalize-hooks\.cjs --patches ..\/patches --upstream \./);
  assert.doesNotMatch(calls, /CALL (apply|tests|build)|bun install/);
});

test('a compatible fallback still runs the full patch and regression gates', () => {
  const { output, calls } = run('success', 'fallback');
  assert.match(output, /RESULT 0 on\/on\/on/);
  assert.match(calls, /check-personalize-hooks\.cjs[\s\S]*CALL apply[\s\S]*CALL tests[\s\S]*CALL build/);
});

test('patch-only CI reaches the runtime gates without local regeneration sources', () => {
  const parent = path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'patch-only-ci-'));
  try {
    const checkout = path.join(directory, 'opencode-src');
    mkdirSync(checkout);
    mkdirSync(path.join(directory, 'patches'));
    mkdirSync(path.join(directory, '.github/scripts'), { recursive: true });
    writeFileSync(path.join(directory, '.github/scripts/check-personalize-hooks.cjs'), '// checker boundary fixture\n');
    // No personalize-src directory or regeneration entry point exists here.
    // Missing Node-script requests use the real Node executable, so a stub
    // cannot hide the exact missing-file failure reported by CI.
    for (const label of ['latest', 'fallback-last-success']) {
      const { output, calls } = run('patches-only', label, checkout);
      assert.match(output, /RESULT 0 on\/on\/on/);
      assert.match(calls, /CALL apply[\s\S]*CALL tests[\s\S]*CALL build/);
      assert.doesNotMatch(calls, /personalize-src|regen-personalize/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('build and sync never depend on local regeneration sources', () => {
  assert.doesNotMatch(workflow + buildScript, /personalize-src|regen-personalize\.ps1/);
});

test('patch-only isolation runs the real checker tests without a local migration receipt', () => {
  const parent = path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'patch-only-isolation-'));
  try {
    const scripts = path.join(directory, '.github/scripts');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(path.join(directory, 'patches'));
    for (const name of ['check-personalize-hooks.cjs', 'personalize-hooks.test.cjs'])
      cpSync(path.join(__dirname, name), path.join(scripts, name));
    for (const name of ['FinalPERSONALIZE.patch', 'FinalPersonalizeX.patch', 'FinalPersonalizeS.patch',
      'FinalPersonalizeR.patch', 'SessionTitleNaming.patch', 'HarnessPermissions.base.patch'])
      cpSync(path.join(__dirname, '../../patches', name), path.join(directory, 'patches', name));
    assert.equal(existsSync(path.join(directory, 'personalize-src')), false);
    // Real subprocesses, not the build-control-flow stubs: local source files
    // must not hide a missing dependency in either the tests or the checker.
    // A nested Node runner must not inherit the parent's child-runner protocol.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_')));
    for (const args of [
      ['--test', '.github/scripts/personalize-hooks.test.cjs'],
      ['.github/scripts/check-personalize-hooks.cjs'],
    ]) {
      const result = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8', env });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      if (args[0] === '--test')
        assert.match(result.stdout, /the mandatory base embeds the complete pinned permissions patch/);
      else
        assert.match(result.stdout, /Release integration budget PASS/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('all five release applications preserve shipped bytes without merge-based conflict handling', () => {
  const applications = buildScript.split('\n').filter((line) => /\bgit apply\b/.test(line));
  assert.equal(applications.length, 5);
  for (const line of applications) assert.match(line, /git apply --index --whitespace=nowarn /);
  assert.doesNotMatch(workflow + buildScript, /--3way|--theirs|--ours|--whitespace=fix/);
  assert.match(workflow, /UPSTREAM_REF: \$\{\{ github\.event\.inputs\.upstream_ref \|\| 'production' \}\}/);
});

test('real workflow rejects drift that Git three-way application would silently merge', () => {
  const parent = path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(path.join(parent, 'strict-patch-'));
  const tree = path.join(root, 'opencode-src');
  const git = process.env.PERSONALIZE_GIT || 'git';
  mkdirSync(tree);
  mkdirSync(path.join(root, 'patches'));
  const runGit = (...args) => {
    const result = spawnSync(git, ['-c', 'core.autocrlf=false', '-c', 'user.name=Fixture',
      '-c', 'user.email=fixture@example.invalid', ...args], { cwd: tree, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    runGit('init', '--quiet');
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}\n`);
    const file = path.join(tree, 'source.txt');
    writeFileSync(file, lines.join(''));
    runGit('add', '--all');
    runGit('commit', '--quiet', '-m', 'fixture base');
    const patched = [...lines];
    patched[11] = 'patched line 12\n';
    writeFileSync(file, patched.join(''));
    const patch = path.join(root, 'patches/FinalPERSONALIZE.patch');
    writeFileSync(patch, runGit('diff', '--full-index'));
    const drift = [...lines];
    drift[8] = 'upstream changed line 9\n';
    writeFileSync(file, drift.join(''));
    runGit('add', '--all');
    runGit('commit', '--quiet', '-m', 'fixture upstream drift');
    runGit('apply', '--3way', '--index', patch);
    assert.match(readFileSync(file, 'utf8'), /patched line 12/);
    runGit('reset', '--hard', 'HEAD');
    const result = spawnSync(bash, ['--noprofile', '--norc', '-s'], {
      cwd: tree, encoding: 'utf8',
      env: { ...buildEnv, PERSONALIZE_TEST_GIT: git.replaceAll('\\', '/') },
      input: `set -euo pipefail
        source "$PERSONALIZE_BUILD_SCRIPT"
        node() { return 0; }
        git() { command "$PERSONALIZE_TEST_GIT" -c core.autocrlf=false "$@"; }
        if apply_custom_git_patches; then echo RESULT:0; else echo RESULT:$?; fi
      `,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /RESULT:20/);
    assert.equal(readFileSync(file, 'utf8'), drift.join(''));
    assert.equal(runGit('ls-files', '-u'), '');
    assert.equal(runGit('diff', '--cached'), '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

const owned = ['context-decay.test.mjs', 'lifetime-effect.test.mjs', 'lifetime.test.mjs', 'session-title.test.mjs',
  'permission-contract.test.mjs', 'single-executable.test.mjs', 'node-typescript.test.mjs', 'bootstrap.test.mjs',
  'storage-diagnostic.test.mjs', 'connection-backoff.test.mjs'];
const permissionRegressions = ['packages/core/test/permission/personalize.integration.test.ts',
  'packages/core/test/permission/service.node.test.mjs', 'packages/server/test/personalize-permission-policy.test.ts',
  'packages/tui/test/personalize-mini-permission.test.ts', 'packages/tui/test/personalize-permission-render.test.tsx',
  'packages/core/test/tool-patch.test.ts', 'packages/core/test/patch.test.ts',
  'packages/core/test/file-access.test.ts', 'packages/core/test/machine-path.test.ts',
  'packages/core/test/tool-patch-target-environment.test.ts'];

function runRegressions(scenario, target = '', science = 'off', transparency = 'off') {
  const parent = path.join(tmpdir(), 'opencode');
  mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'regression-gate-'));
  const files = [
    'packages/cli/tsconfig.json',
    'packages/core/test/session-context-decay.test.ts',
    'packages/core/test/session/content-guards.test.ts',
    'packages/core/test/session-model-request-hooks.test.ts',
    'packages/core/test/session-title.test.ts',
    'packages/core/test/permission.test.ts',
    'packages/core/test/permission/personalize.integration.test.ts',
    'packages/core/test/tool-patch.test.ts',
    'packages/core/test/patch.test.ts',
    'packages/core/test/file-access.test.ts',
    'packages/core/test/machine-path.test.ts',
    'packages/core/test/tool-patch-target-environment.test.ts',
    'packages/core/test/personalize-plugin-registration.test.ts',
    'packages/core/test/personalize-repository-cache.test.ts',
    'packages/core/test/personalize-science-registration.test.ts',
    'packages/tui/test/personalize-transparency-plugin.test.tsx',
    'packages/tui/test/personalize-mini-permission.test.ts',
    'packages/tui/test/personalize-permission-render.test.tsx',
    'packages/tui/test/mini/permission.shared.test.ts',
    'packages/tui/test/util/permission.test.ts',
    'packages/core/test/permission/session-grant.test.mjs',
    'packages/core/test/permission/service.node.test.mjs',
    'packages/server/test/personalize-permission-policy.test.ts',
    'packages/core/test/config/mcp-selection.node.test.mjs',
    'packages/app/src/session/requests/permission-machine.node.test.mjs',
    '.personalize/node-typescript.mjs',
    ...owned.map((name) => `.personalize/${name}`),
  ];
  try {
    for (const file of files) {
      if (scenario === 'missing' && file === (target.includes('/') ? target : `.personalize/${target}`)) continue;
      const location = path.join(directory, file);
      mkdirSync(path.dirname(location), { recursive: true });
      writeFileSync(location, '');
    }
    // Only the real gate's control flow runs. Every test runner is a stub.
    const script = `
      set -euo pipefail
      source "$PERSONALIZE_BUILD_SCRIPT"
      APPLIED_RSI=off
      APPLIED_SCIENCE=${science}
      APPLIED_TRANSPARENCY=${transparency}
      bun() {
        echo "CALL bun $*" >&2
        if [[ "${scenario}" == failure && "$*" == *"${path.basename(target)}"* ]]; then return 1; fi
        return 0
      }
      node() {
        if [[ "$1" == --input-type=module ]]; then echo file:///fixture/effect.js; return 0; fi
        echo "CALL node $*" >&2
        if [[ "${scenario}" == failure && "$*" == *"${path.basename(target)}"* ]]; then return 1; fi
        return 0
      }
      git() { return 0; }
      if run_patch_tests; then status=0; else status=$?; fi
      echo "RESULT $status"
    `;
    const result = spawnSync(bash, ['--noprofile', '--norc', '-s'], {
      input: script, cwd: directory, encoding: 'utf8', env: buildEnv,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return { output: result.stdout, calls: result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const name of [...owned, ...permissionRegressions]) {
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
  assert.match(result.calls, /CALL bun run typecheck:tsc/);
  for (const name of owned) assert.ok(result.calls.includes(`../../.personalize/${name}`));
  assert.ok(result.calls.includes('test/permission/personalize.integration.test.ts'));
  assert.ok(result.calls.includes('packages/core/test/permission/service.node.test.mjs'));
  assert.match(result.calls, /CALL bun run script\/test\.ts /);
  assert.ok(result.calls.includes('test/personalize-plugin-registration.test.ts'));
  assert.ok(result.calls.includes('test/personalize-repository-cache.test.ts'));
  assert.match(result.calls, /CALL node --import \.\/\.personalize\/node-typescript\.mjs --experimental-transform-types --test /);
});

test('a failed CLI/build-adapter typecheck blocks the pre-build gate', () => {
  const result = runRegressions('failure', 'typecheck:tsc');
  assert.match(result.output, /RESULT 1/);
  assert.match(result.calls, /CALL bun run typecheck:tsc/);
  assert.doesNotMatch(result.calls, /CALL bun run script\/test\.ts/);
});

test('missing Node source resolver blocks the mandatory permission regressions', () => {
  assert.match(runRegressions('missing', '.personalize/node-typescript.mjs').output, /RESULT 1/);
});

for (const scenario of ['missing', 'failure']) {
  test(`${scenario} repository-cache regression blocks the pre-build gate`, () => {
    assert.match(runRegressions(scenario, 'packages/core/test/personalize-repository-cache.test.ts').output, /RESULT 1/);
  });
  test(`${scenario} native plugin registration regression blocks the pre-build gate`, () => {
    assert.match(runRegressions(scenario, 'packages/core/test/personalize-plugin-registration.test.ts').output, /RESULT 1/);
  });
  test(`${scenario} science registration regression blocks when S was applied`, () => {
    assert.match(runRegressions(scenario, 'packages/core/test/personalize-science-registration.test.ts', 'on').output, /RESULT 1/);
  });
  test(`${scenario} transparency registration regression blocks when X was applied`, () => {
    assert.match(runRegressions(scenario, 'packages/tui/test/personalize-transparency-plugin.test.tsx', 'off', 'on').output, /RESULT 1/);
  });
}

test('science registration tests run only with their delivered optional plugin', () => {
  const off = runRegressions('missing', 'packages/core/test/personalize-science-registration.test.ts');
  assert.match(off.output, /RESULT 0/);
  assert.doesNotMatch(off.calls, /personalize-science-registration/);
  const on = runRegressions('success', '', 'on');
  assert.match(on.output, /RESULT 0/);
  assert.match(on.calls, /personalize-science-registration/);
});

test('transparency registration tests run only with their delivered optional plugin', () => {
  const off = runRegressions('missing', 'packages/tui/test/personalize-transparency-plugin.test.tsx');
  assert.match(off.output, /RESULT 0/);
  assert.doesNotMatch(off.calls, /personalize-transparency-plugin/);
  const on = runRegressions('success', '', 'off', 'on');
  assert.match(on.output, /RESULT 0/);
  assert.match(on.calls, /CALL bun test test\/personalize-transparency-plugin\.test\.tsx --timeout 30000/);
});
