'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { stripTypeScriptTypes } = require('node:module');
const path = require('node:path');

const patch = readFileSync(path.join(__dirname, '../../patches/FinalPersonalizeX.patch'), 'utf8');
const section = patch.split(/^diff --git /m).find((part) => part.startsWith('a/packages/tui/src/personalize/theme.ts '));
assert.ok(section);
const source = section.split(/\r?\n/).filter((line) => line.startsWith('+') && !line.startsWith('+++')).map((line) => line.slice(1)).join('\n');
const javascript = stripTypeScriptTypes(source, { mode: 'transform', disableExperimentalWarning: true })
  .replace(/^import [^\n]+\n/gm, '').replace(/^export /gm, '');

// Real shipped decorator, with lightweight Solid/renderer/RGBA substitutes.
// This checks token identity/alpha; it is not a screenshot or a live TUI test.
class RGBA {
  constructor(r, g, b, a = 255) { Object.assign(this, { r, g, b, a }); }
  static fromInts(...args) { return new RGBA(...args); }
}

function fixture(on = true, code = javascript) {
  const base = new RGBA(10, 10, 10);
  const orange = new RGBA(250, 178, 131);
  const shared = { base };
  let tokens = { background: { base, action: { primary: { focused: orange } }, field: shared }, text: { action: { primary: { focused: base } }, field: shared }, hue: { black: base } };
  const stockTheme = new Proxy({}, { get: (_, key) => tokens[key] });
  const source = { currentTokens: () => tokens };
  const state = { on };
  const mocks = {
    RGBA,
    useRenderer: () => ({ setBackgroundColor() {} }),
    createEffect: (fn) => fn(),
    createMemo: (fn) => fn,
    createSignal: (initial) => { let value = initial; return [() => value, (next) => { value = next; }]; },
    onCleanup: () => {},
    createComponentTheme: (fn) => new Proxy({}, { get: (_, key) => fn()[key] }),
    useStorageOptional: () => ({ store: () => [state, async (fn) => fn(state)] }),
  };
  const decorate = new Function(...Object.keys(mocks), `${code}\nreturn decorate;`)(...Object.values(mocks));
  const decorated = decorate({ useThemes: () => source, useTheme: () => stockTheme });
  return { base, orange, theme: decorated.useTheme(), themes: decorated.useThemes(), setTokens: (next) => { tokens = next; } };
}

test('transparent slash/command selection keeps its foreground opaque and highlight intact', () => {
  const { theme, themes, base, orange } = fixture();
  assert.equal(theme.background.base.a, 0);
  assert.equal(themes.currentTokens().background.base.a, 0);
  assert.strictEqual(theme.text.action.primary.focused, base);
  assert.equal(theme.text.action.primary.focused.a, 255);
  assert.strictEqual(theme.background.action.primary.focused, orange);
  assert.strictEqual(theme.hue.black, base);
});

test('disabled transparency preserves the original colors', () => {
  const { theme, base, orange } = fixture(false);
  assert.strictEqual(theme.background.base, base);
  assert.strictEqual(theme.text.action.primary.focused, base);
  assert.strictEqual(theme.background.action.primary.focused, orange);
});

test('toggling transparency updates background getters without erasing foregrounds', () => {
  const { theme, themes, base } = fixture(false);
  themes.toggleTransparent();
  assert.equal(theme.background.base.a, 0);
  assert.strictEqual(theme.text.action.primary.focused, base);
  themes.toggleTransparent();
  assert.strictEqual(theme.background.base, base);
});

for (const first of ['background', 'text']) test(`shared objects retain their color role when ${first} is read first`, () => {
  const { theme, base } = fixture();
  void theme[first].field.base;
  assert.equal(theme.background.field.base.a, 0);
  assert.strictEqual(theme.text.field.base, base);
});

test('theme changes use the new base without turning selected text transparent', () => {
  const { theme, setTokens } = fixture();
  void theme.background.base;
  const base = new RGBA(20, 20, 20);
  setTokens({ background: { base }, text: { action: { primary: { focused: base } } } });
  assert.equal(theme.background.base.a, 0);
  assert.strictEqual(theme.text.action.primary.focused, base);
});

test('the previous color-wide transparency reproduces an erased selection foreground', () => {
  const broken = javascript.replace('background && facade.transparent()', 'facade.transparent()');
  assert.notEqual(broken, javascript);
  const { theme } = fixture(true, broken);
  assert.equal(theme.text.action.primary.focused.a, 0);
});
