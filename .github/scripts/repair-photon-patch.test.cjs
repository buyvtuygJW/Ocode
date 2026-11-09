const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { repairText } = require('./repair-photon-patch.cjs');

const bad = "@@ -4509,7 +4510,8 @@\n      ;\n  };\n  \n-const path = require('path').join(__dirname, 'photon_rs_bg.wasm');\n+const path = process.env.OPENCODE_PHOTON_WASM_PATH || require('path').join(__dirname, 'photon_rs_bg.wasm');\n";
const good = bad.replace('\n      ;\n  };\n  \n-', '\n     ;\n };\n \n-');

test('repairs only the known bad context and is idempotent', () => {
  assert.deepEqual(repairText(bad), { text: good, repaired: true });
  assert.deepEqual(repairText(good), { text: good, repaired: false });
});

test('preserves CRLF and does not alter unknown patches', () => {
  const input = bad.replaceAll('\n', '\r\n');
  assert.deepEqual(repairText(input), { text: good.replaceAll('\n', '\r\n'), repaired: true });
  assert.deepEqual(repairText('unrelated change\n'), { text: 'unrelated change\n', repaired: false });
});

test('rejects an ambiguous duplicate instead of guessing', () => {
  assert.throws(() => repairText(bad + bad), /duplicate known hunk/);
});

test('v11 patch delivers the same repair used by the tests', () => {
  const patch = fs.readFileSync(path.resolve(__dirname, '../../patches/FinalPERSONALIZE.patch'), 'utf8').replaceAll('\r\n', '\n');
  const target = '.personalize/repair-photon-patch.cjs';
  const marker = `diff --git a/${target} b/${target}\n`;
  const start = patch.indexOf(marker);
  assert.notEqual(start, -1, 'repair is missing from FinalPERSONALIZE.patch');
  assert.equal(patch.indexOf(marker, start + marker.length), -1, 'duplicate repair section');
  const next = patch.indexOf('\ndiff --git ', start + marker.length);
  const section = patch.slice(start, next < 0 ? undefined : next).split('\n');
  const hunk = section.findIndex((line) => line.startsWith('@@ '));
  assert.notEqual(hunk, -1);
  const body = section.slice(hunk + 1).filter((line) => line.startsWith('+')).map((line) => line.slice(1)).join('\n') + '\n';
  const helper = fs.readFileSync(path.join(__dirname, 'repair-photon-patch.cjs'), 'utf8').replaceAll('\r\n', '\n');
  assert.equal(body, helper);
});
