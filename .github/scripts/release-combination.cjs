'use strict';

// A successful upstream SHA alone says nothing about today's patches/toolchain.
// This receipt is written only after the workflow's tests, build and packaging.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sha = /^[a-f0-9]{40}$/;
const hash = /^[a-f0-9]{64}$/;

function inventory(root, directories) {
  const result = {};
  function walk(relative) {
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`Unexpected receipt symlink: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) walk(`${relative}/${name}`);
    } else if (stat.isFile()) result[relative] = digest(file);
    else throw new Error(`Unexpected receipt input: ${relative}`);
  }
  for (const directory of directories) walk(directory);
  return result;
}

function inputs(root) {
  // Only the shipped patch stack, not upstream dependency patches, legacy
  // backups or local review notes (which are not copied by the sync step).
  const required = ['FinalPERSONALIZE.patch', 'HarnessPermissions.base.patch', 'SessionTitleNaming.patch'];
  const optional = ['FinalPersonalizeR.patch', 'FinalPersonalizeS.patch', 'FinalPersonalizeX.patch', 'build-openscience-skills.sh'];
  return inventory(root, [
    ...required.map((name) => `patches/${name}`),
    ...optional.filter((name) => fs.existsSync(path.join(root, 'patches', name))).map((name) => `patches/${name}`),
    '.github/scripts', '.github/workflows/weekly_customautorel.yml',
  ]);
}

function record(root, upstream, bun, sourceCommit, artifacts) {
  if (!sha.test(upstream) || !sha.test(sourceCommit)) throw new Error('Full upstream/source commits are required');
  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(bun)) throw new Error('Exact Bun version is required');
  const files = inventory(artifacts, ['.']);
  if (Object.keys(files).length < 8) throw new Error('Packaged release artifacts are missing');
  return {
    version: 1, upstream, sourceCommit, bun, node: process.version,
    platform: process.platform, arch: process.arch,
    inputs: inputs(root), artifacts: files,
  };
}

function verify(root, receipt, bun, upstream) {
  if (receipt.version !== 1 || !sha.test(receipt.upstream) || !sha.test(receipt.sourceCommit) ||
    receipt.upstream !== upstream) throw new Error('Missing or mismatched release-combination identity');
  if (receipt.bun !== bun || receipt.node !== process.version ||
    receipt.platform !== process.platform || receipt.arch !== process.arch)
    throw new Error('Fallback toolchain differs from its successful combination');
  const current = inputs(root);
  const expected = receipt.inputs;
  if (!expected || Object.keys(expected).length !== Object.keys(current).length ||
    Object.entries(current).some(([file, value]) => expected[file] !== value))
    throw new Error('Fallback patches/helpers differ from their successful combination');
  if (!receipt.artifacts || Object.keys(receipt.artifacts).length < 8 ||
    Object.values(receipt.artifacts).some((value) => typeof value !== 'string' || !hash.test(value)))
    throw new Error('Fallback receipt lacks packaged artifact digests');
  return receipt.upstream;
}

module.exports = { record, verify };
if (require.main === module) {
  const [command, root, file, bun, upstream, sourceCommit, artifacts] = process.argv.slice(2);
  try {
    if (command === 'verify')
      console.log(verify(root, JSON.parse(fs.readFileSync(file, 'utf8')), bun, upstream));
    else if (command === 'record')
      fs.writeFileSync(file, JSON.stringify(record(root, upstream, bun, sourceCommit, artifacts), null, 2) + '\n', { flag: 'wx' });
    else throw new Error('Expected record or verify');
  } catch (error) {
    console.error(`Release combination rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
