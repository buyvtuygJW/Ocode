'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { analyze } = require('./check-personalize-hooks.cjs');

const ALLOWED = 'packages/cli/script/build.ts';
const MANIFEST = JSON.stringify({ modules: [] });
const SHIM = 'export {}';

const hook = (file, count) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n` +
  Array.from({ length: count }, (_, i) => `@@ -${i + 1},1 +${i + 1},1 @@\n-old\n+new\n`).join('');
const hookWith = (file, body) =>
  `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,3 +1,3 @@\n context\n-old\n+${body}\n`;
const owned = (file, body) => `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,1 @@\n+${body}\n`;
const ownedLines = (file, lines) =>
  `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1,${lines.length} @@\n` +
  lines.map((line) => `+${line}`).join('\n') + '\n';
const manifestSection = () => owned('.personalize/manifest.json', MANIFEST);
const shimSection = () => owned('.personalize/build.mjs', SHIM);

test('only the small CLI build integration may touch upstream', () => {
  assert.deepEqual(analyze({ core: hook(ALLOWED, 2) }), { files: 1, hunks: 2, owned: 0 });
  assert.throws(() => analyze({ core: hook('packages/core/src/session/model-request.ts', 1) }), /Forbidden upstream edit/);
});

test('hook points are counted across every patch, not per patch', () => {
  assert.throws(() => analyze({ core: hook(ALLOWED, 3), extra: hook(ALLOWED, 2) }), /Maximum four/);
});

test('owned modules do not consume upstream hook points', () => {
  assert.deepEqual(analyze({ core: hook(ALLOWED, 2), r: owned('packages/core/src/personalize/tools.ts', 'export const tools = []') }),
    { files: 1, hunks: 2, owned: 1 });
});

test('duplicate owned files cannot disguise overlapping modifications', () => {
  const addition = owned('.personalize/example.ts', 'export {}');
  assert.throws(() => analyze({ core: addition, extra: addition }), /Duplicate owned file/);
});

test('manifest factories must actually be delivered by the patch set', () => {
  const manifest = JSON.stringify({ modules: [{ target: 'stock.ts', factory: 'missing.ts', exports: ['value'] }] });
  assert.throws(() => analyze({ core: owned('.personalize/manifest.json', manifest) }), /Missing owned runtime module/);
});

test('path traversal is never accepted as an owned module', () => {
  assert.throws(() => analyze({ core: owned('../outside.ts', 'export {}') }), /unsafe path/);
});

test('renames and backslash paths are rejected before any rule applies', () => {
  assert.throws(() => analyze({ core: 'diff --git a/old.ts b/new.ts\n--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-a\n+b\n' }),
    /renames are not allowed/);
  assert.throws(() => analyze({ core: owned('evil\\path.ts', 'export {}') }), /unsafe path/);
});

test('malformed new-file sections fail loudly instead of yielding a partial body', () => {
  const malformed =
    `diff --git a/bad.ts b/bad.ts\nnew file mode 100644\n--- /dev/null\n+++ b/bad.ts\n@@ -0,0 +1,2 @@\n+export {}\n context line\n`;
  assert.throws(() => analyze({ core: malformed }), /malformed new-file diff/);
});

test('invalid manifest JSON reports the manifest, not a raw SyntaxError', () => {
  assert.throws(() => analyze({ r: owned('.personalize/R.json', '{oops') }), /Invalid JSON in \.personalize\/R\.json/);
  assert.throws(() => analyze({ core: owned('.personalize/manifest.json', 'not json') }), /Invalid JSON/);
});

test('a delivered manifest requires the build shim that loads it', () => {
  assert.throws(() => analyze({ core: manifestSection() }), /Missing owned build shim/);
  assert.deepEqual(analyze({ core: manifestSection() + shimSection() }), { files: 0, hunks: 0, owned: 2 });
});

test('the allowed build hook must load the owned module boundaries', () => {
  const base = manifestSection() + shimSection();
  assert.throws(() => analyze({ core: base + hookWith(ALLOWED, 'unrelated edit') }), /does not load the owned module boundaries/);
  assert.deepEqual(
    analyze({ core: base + hookWith(ALLOWED, 'import { PersonalizeBuild } from "../../../.personalize/build.mjs"') }),
    { files: 1, hunks: 1, owned: 2 }
  );
});

test('new-file body lines starting with "++" survive extraction and still get checked', () => {
  const root = path.join(tmpdir(), 'opencode');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, 'personalize-check-'));
  try {
    writeFileSync(path.join(directory, 'stock.ts'), 'export const visible = 1\n');
    const manifest = owned('.personalize/manifest.json',
      JSON.stringify({ modules: [{ target: 'stock.ts', factory: 'owned.ts', exports: [] }] }));
    // '++ ' body lines encode to '+++ ' in the diff; a naive header filter drops them.
    const broken = ownedLines('owned.ts', ['export const decorate = (stock) => ({})', '++ stock.hidden']);
    assert.throws(() => analyze({ core: manifest + broken }, directory), /non-public export: stock\.ts#hidden/);
    const good = ownedLines('owned.ts', ['export const decorate = (stock) => ({})', '++ stock.visible']);
    assert.deepEqual(analyze({ core: manifest + good + shimSection() }, directory), { files: 0, hunks: 0, owned: 3 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the CLI refuses to silently pass when the mandatory patch is missing', () => {
  const root = path.join(tmpdir(), 'opencode');
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, 'personalize-check-'));
  try {
    const result = spawnSync(process.execPath,
      [path.join(__dirname, 'check-personalize-hooks.cjs'), '--patches', directory],
      { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Missing mandatory patch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('context-provider destructuring exports the alias, including multiline bindings', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'opencode', 'personalize-exports-'));
  try {
    writeFileSync(path.join(directory, 'stock.ts'), 'export const {\n  use: useClient,\n  provider: ClientProvider,\n} = context()\n');
    const fixture = (name) => owned('.personalize/manifest.json', JSON.stringify({ modules: [
      { target: 'stock.ts', factory: 'owned.ts', exports: [name] },
    ] })) + owned('owned.ts', `export const decorate = (stock) => ({ ${name}: stock.${name} })`) + shimSection();
    assert.doesNotThrow(() => analyze({ core: fixture('ClientProvider') }, directory));
    assert.doesNotThrow(() => analyze({ core: fixture('useClient') }, directory));
    assert.throws(() => analyze({ core: fixture('provider') }, directory), /Public export changed/);
    assert.throws(() => analyze({ core: fixture('missing') }, directory), /Public export changed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
