'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Synthetic ESM compatibility check, not a Bun execution. Use the exact loader
// shipped in R, with Bun's missing node:module export and trailing-export shape.
const patch = readFileSync(path.join(__dirname, '../../patches/FinalPersonalizeR.patch'), 'utf8');
const section = patch.split(/^diff --git /m).find((part) => part.startsWith('a/.personalize/legacy.test.mjs '));
assert.ok(section, 'R must deliver its regression loader');
const source = section.split(/\r?\n/).filter((line) => line.startsWith('+') && !line.startsWith('+++')).map((line) => line.slice(1)).join('\n');
const end = source.indexOf('const { define } = load(');
assert.ok(end > 0);

async function loader(input = source.slice(0, end)) {
  const context = vm.createContext({ URL, process: { env: {} }, Bun: {
    Transpiler: class {
      transformSync() {
        return 'import { value } from "fixture";\nconst localAnswer = value + 1;\nexport {\n  localAnswer as answer,\n};\n';
      }
    },
  } });
  let nodeModuleImports = 0;
  const synthetic = async (name) => {
    if (name === 'node:module') nodeModuleImports++;
    const exports = name === 'node:module' ? { createRequire: () => ({ resolve: () => '/fixture/effect.js' }) }
      : name === 'node:fs' ? { readFileSync: () => 'fixture TypeScript' }
      : name.startsWith('node:') ? await import(name)
      : { Context: {}, Deferred: {}, Effect: {}, JsonSchema: {}, Schema: {}, Scope: {} };
    const module = new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
    await module.link(() => {});
    await module.evaluate();
    return module;
  };
  const module = new vm.SourceTextModule(`${input}\nexport { load };`, {
    context,
    initializeImportMeta(meta) { meta.url = 'file:///fixture/.personalize/legacy.test.mjs'; },
    importModuleDynamically: synthetic,
  });
  await module.link(synthetic);
  await module.evaluate();
  assert.equal(nodeModuleImports, 1, 'Bun must not dynamically load the Node-only transpiler');
  return module.namespace.load;
}

test('R loader links without stripTypeScriptTypes and evaluates trailing transpiler exports', async () => {
  const load = await loader();
  assert.equal(load('fixture.ts', { fixture: { value: 41 } }, ['answer']).answer, 42);
  assert.throws(() => load('fixture.ts', {}, ['answer']), /Unmocked import/);
});

test('the original static named import is detected before any fixture runs', async () => {
  const broken = source.slice(0, end).replace('import { createRequire }', 'import { createRequire, stripTypeScriptTypes as oldStrip }');
  await assert.rejects(loader(broken), /does not provide an export named 'stripTypeScriptTypes'/);
});

test('removing the trailing-export cleanup is detected', async () => {
  const broken = source.slice(0, end).replace(/    \.replace\(\/\^export\\s\*\\\{[^\n]*\n[\s\S]*?^    \}\)\n/m, '');
  assert.notEqual(broken, source.slice(0, end));
  const load = await loader(broken);
  assert.throws(() => load('fixture.ts', { fixture: { value: 41 } }, ['answer']), { name: 'SyntaxError' });
});
