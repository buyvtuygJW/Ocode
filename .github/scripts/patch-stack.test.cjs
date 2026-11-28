'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { checkPatchStack, ORDER } = require('./check-patch-stack.cjs');
const git = process.env.PERSONALIZE_GIT || 'git';
const bus = 'packages/core/src/bus.ts';
const oldBus = 'function commitDurableEvent() {\n  return transaction()\n    .pipe(Effect.orDie)\n}\n';
const newBus = oldBus.replace('Effect.orDie', 'Effect.catchIf(isSqlError, Effect.die)');

function patch(file, before, after) {
  const a = before?.trimEnd().split('\n') ?? [];
  const b = after.trimEnd().split('\n');
  return `diff --git a/${file} b/${file}\n${before === undefined ? 'new file mode 100644\n' : ''}` +
    `--- ${before === undefined ? '/dev/null' : `a/${file}`}\n+++ b/${file}\n` +
    `@@ -${a.length ? '1' : '0'},${a.length} +1,${b.length} @@\n` +
    a.map((line) => `-${line}\n`).join('') + b.map((line) => `+${line}\n`).join('');
}

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-stack-test-'));
  const upstream = path.join(root, 'upstream');
  const directory = path.join(root, 'patches');
  fs.mkdirSync(upstream);
  fs.mkdirSync(directory);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  function run(...args) {
    const result = spawnSync(git, ['-c', 'core.autocrlf=false', '-c', 'core.filemode=false',
      '-c', 'user.name=Patch Test', '-c', 'user.email=patch-test@example.invalid',
      '-c', `safe.directory=${upstream.replaceAll('\\', '/')}`, '-C', upstream, ...args], { env, encoding: 'utf8' });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  }
  function write(file, text) {
    fs.mkdirSync(path.dirname(path.join(upstream, file)), { recursive: true });
    fs.writeFileSync(path.join(upstream, file), text);
  }
  const save = (name, text) => fs.writeFileSync(path.join(directory, name), text);
  try {
    run('init', '--quiet');
    write(bus, newBus);
    run('add', '--all');
    run('commit', '--quiet', '-m', 'upstream typed commit failures');
    save(ORDER[0], patch(bus, newBus, newBus.replace('return transaction()', 'return checkedTransaction()')));
    save(ORDER.at(-1), patch('title.txt', undefined, 'title\n'));
    fn({ upstream, directory, run, write, save, check: () => checkPatchStack({ upstream, directory, git }) });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('bus.ts typed-commit upstream drift fails indexed preflight even when footprint is unchanged', () => fixture(({ save, check }) => {
  save(ORDER[0], patch(bus, oldBus, oldBus.replace('return transaction()', 'return checkedTransaction()')));
  assert.throws(check, /compatibility FAILED.*FinalPERSONALIZE\.patch[\s\S]*packages\/core\/src\/bus\.ts: patch does not apply/);
}));

test('reviewed bus rebase passes and preflight leaves caller HEAD, index and local edits untouched', () => fixture(({ upstream, write, run, check }) => {
  write('local.txt', 'staged user work\n');
  run('add', 'local.txt');
  write(bus, newBus + '// unstaged user work\n');
  const head = run('rev-parse', 'HEAD');
  const index = fs.readFileSync(path.join(upstream, '.git/index'));
  const working = fs.readFileSync(path.join(upstream, bus));
  const result = check();
  assert.equal(result.revision, head.trim());
  assert.deepEqual(result.patches, [ORDER[0], ORDER.at(-1)]);
  assert.equal(run('rev-parse', 'HEAD'), head);
  assert.deepEqual(fs.readFileSync(path.join(upstream, '.git/index')), index);
  assert.deepEqual(fs.readFileSync(path.join(upstream, bus)), working);
  assert.equal(fs.existsSync(path.join(upstream, 'title.txt')), false);
}));

test('whole stack applies in actual base/X/S/R/title order, not independently', () => fixture(({ save, check }) => {
  save(ORDER[0], patch('chain.txt', undefined, 'base\n'));
  for (let i = 1; i < ORDER.length; i++)
    save(ORDER[i], patch('chain.txt', i === 1 ? 'base\n' : `${ORDER[i - 1]}\n`, `${ORDER[i]}\n`));
  assert.deepEqual(check().patches, ORDER);
  save(ORDER[3], patch('chain.txt', 'wrong predecessor\n', 'R\n'));
  assert.throws(check, /compatibility FAILED.*FinalPersonalizeR\.patch/);
}));

test('title conflicts and owned-file collisions cannot pass an earlier base check', () => fixture(({ save, check, run, write }) => {
  save(ORDER.at(-1), patch(bus, oldBus, 'bad title edit\n'));
  assert.throws(check, /compatibility FAILED.*SessionTitleNaming\.patch/);
  save(ORDER.at(-1), patch('title.txt', undefined, 'title\n'));
  write('title.txt', 'upstream now owns this\n');
  run('add', 'title.txt');
  run('commit', '--quiet', '-m', 'owned collision');
  assert.throws(check, /compatibility FAILED.*SessionTitleNaming\.patch[\s\S]*already exists/);
}));

test('missing mandatory title and unsupported traversal fail closed', () => fixture(({ directory, save, check }) => {
  fs.unlinkSync(path.join(directory, ORDER.at(-1)));
  assert.throws(check, /Missing mandatory release patch: SessionTitleNaming.patch/);
  save(ORDER.at(-1), patch('../outside', undefined, 'escape\n'));
  assert.throws(check, /unsupported patch path/);
}));

test('real release function detects bus conflict before workflow removal, patching, install or build', () => fixture(({ upstream, directory, save }) => {
  save(ORDER[0], patch(bus, oldBus, oldBus.replace('return transaction()', 'return checkedTransaction()')));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, {
    PERSONALIZE_BUILD_SCRIPT: path.resolve(__dirname, '../workflows/build-personalize.sh').replaceAll('\\', '/'),
    PERSONALIZE_PREFLIGHT: path.resolve(__dirname, 'check-patch-stack.cjs').replaceAll('\\', '/'),
    PERSONALIZE_NODE: process.execPath.replaceAll('\\', '/'),
    PERSONALIZE_GIT: git.replaceAll('\\', '/'),
    UPSTREAM_REPO: upstream.replaceAll('\\', '/'),
    GITHUB_OUTPUT: path.join(path.dirname(directory), 'outputs').replaceAll('\\', '/'),
  });
  const result = spawnSync(process.env.PERSONALIZE_TEST_BASH || 'bash', ['--noprofile', '--norc', '-s'], {
    cwd: path.dirname(directory), env, encoding: 'utf8',
    input: `
      source "$PERSONALIZE_BUILD_SCRIPT"
      git() { command "$PERSONALIZE_GIT" -c core.autocrlf=false "$@"; }
      node() {
        if [[ "$1" == *check-personalize-hooks.cjs ]]; then
          shift
          command "$PERSONALIZE_NODE" "$PERSONALIZE_PREFLIGHT" "$@"
        else echo UNEXPECTED_NODE; return 99; fi
      }
      strip_upstream_workflows() { echo UNEXPECTED_STRIP; return 99; }
      apply_custom_git_patches() { echo UNEXPECTED_APPLY; return 99; }
      run_patch_tests() { echo UNEXPECTED_TESTS; return 99; }
      run_opencode_build() { echo UNEXPECTED_BUILD; return 99; }
      bun() { echo UNEXPECTED_INSTALL; return 99; }
      if try_build HEAD latest; then echo RESULT:0; else echo RESULT:$?; fi
    `,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /RESULT:12/);
  assert.match(result.stderr, /packages\/core\/src\/bus\.ts: patch does not apply/);
  assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_/);
}));
