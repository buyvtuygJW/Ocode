'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { record, verify } = require('./release-combination.cjs');

test('fallback requires the same tested patch/helper bytes and toolchain, not an old SHA', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-combination-'));
  const upstream = '1'.repeat(40);
  try {
    for (const dir of ['patches', '.github/scripts', '.github/workflows', 'out'])
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (const name of ['FinalPERSONALIZE.patch', 'HarnessPermissions.base.patch', 'SessionTitleNaming.patch'])
      fs.writeFileSync(path.join(root, 'patches', name), 'patch');
    fs.writeFileSync(path.join(root, '.github/scripts/check.cjs'), 'gate');
    fs.writeFileSync(path.join(root, '.github/workflows/weekly_customautorel.yml'), 'workflow');
    for (let i = 0; i < 8; i++) fs.writeFileSync(path.join(root, `out/target-${i}`), `binary${i}`);
    const receipt = record(root, upstream, '1.3.3', '2'.repeat(40), path.join(root, 'out'));
    assert.equal(verify(root, receipt, '1.3.3', upstream), upstream);
    fs.writeFileSync(path.join(root, 'patches/legacy.patch.bak'), 'not shipped');
    assert.equal(verify(root, receipt, '1.3.3', upstream), upstream);
    assert.throws(() => verify(root, {}, '1.3.3', upstream), /identity/);
    assert.throws(() => verify(root, receipt, '1.3.3', '3'.repeat(40)), /identity/);
    assert.throws(() => verify(root, receipt, '1.3.4', upstream), /toolchain/);
    assert.throws(() => verify(root, { ...receipt, artifacts: {} }, '1.3.3', upstream), /artifact/);
    fs.writeFileSync(path.join(root, 'patches/FinalPERSONALIZE.patch'), 'new fix');
    assert.throws(() => verify(root, receipt, '1.3.3', upstream), /patches\/helpers/);
    fs.writeFileSync(path.join(root, 'patches/FinalPERSONALIZE.patch'), 'patch');
    fs.writeFileSync(path.join(root, '.github/scripts/check.cjs'), 'changed gate');
    assert.throws(() => verify(root, receipt, '1.3.3', upstream), /patches\/helpers/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
