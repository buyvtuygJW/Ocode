'use strict';

// Enforces the personalization isolation contract on the generated patch set:
//   * at most THREE upstream integration points PER FILE, summed across the release:
//     every edit hunk (including permissions, titles and tests) plus every
//     distinct upstream module replaced/decorated by a delivered manifest;
//   * outside the pinned permission/title segments, only the CLI bootstrap may
//     edit an upstream file;
//   * everything else ships as OWNED new files (no renames, no binary sections,
//     no path traversal, no collisions with upstream files);
//   * every manifest entry's owned modules are actually delivered by the patches;
//   * the build shim (.personalize/build.mjs) is delivered whenever any manifest is;
//   * the one allowed hook actually loads the owned boundaries (a build.ts edit
//     that ignores them would silently ship inert owned modules);
//   * with --upstream: declared exports and every `stock.X` access in a factory
//     still resolve to public exports of the LIVE upstream module.
//
// analyze() verifies segment integrity and bootstrap wiring; it is NOT a release
// approval. enforceReleaseBudget() must see the unstripped patch set, with titles.

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const NAMES = ['FinalPERSONALIZE.patch', 'FinalPersonalizeR.patch', 'FinalPersonalizeS.patch', 'FinalPersonalizeX.patch'];
const MANDATORY = 'FinalPERSONALIZE.patch';
const PERMISSIONS = 'HarnessPermissions.base.patch';
const PERMISSIONS_SHA256 = '1fd5cbb626f42c06261279995e084783b59a38a032e53051f5d7a45b269e252e';
const PERMISSION_FILE_COUNT = 26;
const TITLE_SHA256 = 'e3961c5be373aca71fe8f4a062148d812390b9c0921dfc269eac08375c97f999';
const ALLOWED = 'packages/cli/script/build.ts';
const MANIFESTS = ['manifest.json', 'R.json', 'S.json', 'X.json'];
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function diffPath(name, section) {
  const header = section.split('\n', 1)[0];
  const marker = ' b/';
  const at = header.lastIndexOf(marker);
  if (!header.startsWith('diff --git a/') || at < 'diff --git a/'.length) {
    throw new Error(`${name}: unsupported diff header: ${header}`);
  }
  const left = header.slice('diff --git a/'.length, at);
  const right = header.slice(at + marker.length);
  if (left !== right) throw new Error(`${name}: renames are not allowed: ${header}`);
  return right;
}

function safePath(name, file) {
  if (
    !file ||
    path.isAbsolute(file) ||
    file.includes('\\') ||
    file.includes('\0') ||
    file.split('/').includes('..') ||
    file.split('/').includes('')
  ) {
    throw new Error(`${name}: unsafe path ${JSON.stringify(file)}`);
  }
  return file;
}

// Exact body of a new-file section. Only '+' payload lines after a hunk header
// count; '\ No newline' markers and the trailing empty line are skipped. Anything
// else inside a new-file diff is malformed and must fail loudly.
function ownedBody(name, file, section) {
  const body = [];
  let inHunk = false;
  for (const line of section.split('\n')) {
    if (line.startsWith('@@ ')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) body.push(line.slice(1));
    else if (line.startsWith('\\') || line === '') continue;
    else throw new Error(`${name}: malformed new-file diff for ${file}: ${JSON.stringify(line)}`);
  }
  return body.join('\n');
}

function publicExports(source) {
  const names = new Set([...source.matchAll(/^export\s+(?:async\s+)?(?:const|let|function|class|interface|type)\s+(\w+)/gm)].map((m) => m[1]));
  // Context providers use exported object bindings, often formatted over several
  // lines. The alias is the export (ClientProvider), not the property (provider).
  for (const binding of source.matchAll(/^export\s+(?:const|let|var)\s*\{([^{}]+)\}\s*=/gm)) {
    for (const item of binding[1].split(',')) {
      const match = item.trim().match(/^(?:\.\.\.)?([A-Za-z_$][\w$]*)(?:\s*:\s*([A-Za-z_$][\w$]*))?(?:\s*=[\s\S]+)?$/);
      if (match) names.add(match[2] || match[1]);
    }
  }
  for (const clause of source.matchAll(/^export\s*\{([^}]+)\}/gm)) {
    for (const item of clause[1].split(',')) {
      const name = item.trim().split(/\s+as\s+/).at(-1);
      if (IDENTIFIER.test(name)) names.add(name);
    }
  }
  return names;
}

function addedLines(section, file) {
  // Exclude ONLY the literal '+++ b/<file>' header; a body line starting with
  // '++ ' is diff-encoded as '+++ ' and must be kept.
  const header = `+++ b/${file}`;
  return section.split('\n').filter((line) => line.startsWith('+') && line !== header).map((line) => line.slice(1));
}

function analyze(patches, upstream, permissions, review = {}) {
  let permissionFiles = 0;
  const permissionAdditions = new Set();
  if (permissions !== undefined) {
    const required = String(permissions).replaceAll('\r\n', '\n');
    const hash = createHash('sha256').update(required).digest('hex');
    // Only the offline generator supplies a reviewed candidate checksum.
    // The CLI always verifies the committed pin above.
    if (hash !== (review.permissionSHA256 ?? PERMISSIONS_SHA256)) throw new Error('Mandatory permissions patch checksum mismatch');
    const base = String(patches[MANDATORY] || '').replaceAll('\r\n', '\n');
    if (!base.endsWith(required)) throw new Error('Mandatory permissions are missing or altered in the base patch');
    const seen = new Set();
    for (const section of required.split(/(?=^diff --git )/m).filter((s) => s.startsWith('diff --git '))) {
      const file = safePath(PERMISSIONS, diffPath(PERMISSIONS, section));
      if (seen.has(file)) throw new Error(`Duplicate permission file: ${file}`);
      seen.add(file);
      if (section.includes('\n--- /dev/null\n')) permissionAdditions.add(file);
      if (upstream) {
        const exists = fs.existsSync(path.join(upstream, file));
        if (section.includes('\n--- /dev/null\n') && exists) throw new Error(`Permission file collision with upstream: ${file}`);
        if (!section.includes('\n--- /dev/null\n') && !exists) throw new Error(`Permission target missing upstream: ${file}`);
      }
    }
    permissionFiles = seen.size;
    const expectedFiles = review.permissionFileCount ?? PERMISSION_FILE_COUNT;
    if (!Number.isSafeInteger(expectedFiles) || expectedFiles < 0) throw new Error('Invalid reviewed permission file count');
    if (permissionFiles !== expectedFiles) throw new Error(`Expected ${expectedFiles} mandatory permission files; found ${permissionFiles}`);
    patches = { ...patches, [MANDATORY]: base.slice(0, -required.length) };
  }
  const hooks = [];
  const additions = new Map();
  for (const [name, text] of Object.entries(patches)) {
    for (const section of String(text)
      .replaceAll('\r\n', '\n')
      .split(/(?=^diff --git )/m)
      .filter((s) => s.startsWith('diff --git '))) {
      const file = safePath(name, diffPath(name, section));
      if (section.includes('\n--- /dev/null\n')) {
        if (permissionAdditions.has(file)) throw new Error(`Duplicate owned file across mandatory permissions: ${file}`);
        if (additions.has(file)) throw new Error(`Duplicate owned file: ${file}`);
        if (upstream && fs.existsSync(path.join(upstream, file))) {
          throw new Error(`Owned-file collision with upstream: ${file}`);
        }
        additions.set(file, ownedBody(name, file, section));
      } else {
        const hunks = (section.match(/^@@ /gm) || []).length;
        if (file !== ALLOWED) throw new Error(`Forbidden upstream edit: ${name}: ${file}`);
        hooks.push({ file, hunks, section });
      }
    }
  }
  const hunks = hooks.reduce((sum, entry) => sum + entry.hunks, 0);
  if (hunks > 3) throw new Error(`Maximum three upstream bootstrap hook points; found ${hunks}`);

  const delivered = MANIFESTS.filter((name) => additions.has(`.personalize/${name}`));
  for (const name of delivered) {
    let manifest;
    try {
      manifest = JSON.parse(additions.get(`.personalize/${name}`));
    } catch (error) {
      throw new Error(`Invalid JSON in .personalize/${name}: ${error.message}`);
    }
    if (!manifest || !Array.isArray(manifest.modules)) {
      throw new Error(`.personalize/${name} must contain a modules array`);
    }
    for (const module of manifest.modules) {
      if (!module || typeof module.target !== 'string') {
        throw new Error(`.personalize/${name} entry without a target`);
      }
      const owned = [...(Array.isArray(module.before) ? module.before : []), ...(typeof module.factory === 'string' ? [module.factory] : [])];
      for (const file of owned) {
        if (typeof file !== 'string' || !additions.has(file)) throw new Error(`Missing owned runtime module: ${file}`);
      }
      const exported = Array.isArray(module.exports) ? module.exports : [];
      for (const identifier of exported) {
        if (typeof identifier !== 'string' || !IDENTIFIER.test(identifier)) {
          throw new Error(`Invalid export name in .personalize/${name}: ${JSON.stringify(identifier)}`);
        }
      }
      if (!upstream) continue;
      const target = path.join(upstream, module.target);
      if (!fs.existsSync(target)) throw new Error(`Upstream module no longer exists: ${module.target}`);
      const names = publicExports(fs.readFileSync(target, 'utf8'));
      for (const identifier of exported) {
        if (!names.has(identifier)) throw new Error(`Public export changed: ${module.target}#${identifier}`);
      }
      if (typeof module.factory === 'string') {
        for (const access of additions.get(module.factory).matchAll(/\bstock\.(\w+)/g)) {
          if (!names.has(access[1])) {
            throw new Error(`Owned wrapper uses a non-public export: ${module.target}#${access[1]}`);
          }
        }
      }
    }
  }

  if (delivered.length > 0 && !additions.has('.personalize/build.mjs')) {
    throw new Error('Missing owned build shim: .personalize/build.mjs');
  }
  if (delivered.length > 0) {
    const wired = hooks.some((entry) =>
      addedLines(entry.section, entry.file).some((line) => line.includes('.personalize/build.mjs') || line.includes('PersonalizeBuild'))
    );
    if (!wired) throw new Error('The allowed build hook does not load the owned module boundaries');
  }
  return { files: new Set(hooks.map((h) => h.file)).size, hunks, owned: additions.size, ...(permissions === undefined ? {} : { permissionFiles }) };
}

function footprint(patches) {
  const modified = new Set();
  let hunks = 0;
  for (const [name, text] of Object.entries(patches)) {
    for (const section of String(text).replaceAll('\r\n', '\n').split(/(?=^diff --git )/m)) {
      if (!section.startsWith('diff --git ') || section.includes('\n--- /dev/null\n')) continue;
      modified.add(safePath(name, diffPath(name, section)));
      hunks += (section.match(/^@@ /gm) || []).length;
    }
  }
  return { files: modified.size, hunks };
}

function enforceReleaseBudget(patches) {
  const total = footprint(patches);
  const ledger = integrationLedger(patches);
  const violations = ledger.filter((entry) => entry.points > 3);
  if (violations.length) {
    throw new Error(
      'Release rejected: maximum 3 upstream edit/injection points PER FILE across all patches. Offending files:\n' +
      violations.map(({ file, hunks, injections, points }) =>
        `  ${file}: ${points} points (${hunks} edit hunks + ${injections} module boundary)`).join('\n') + '\n' +
      'Permissions, titles and upstream tests are not exempt. Refactor the integration; do not force conflicts or hide edits in owned replacements.'
    );
  }
  return total;
}

function integrationLedger(patches) {
  const files = new Map();
  const entry = (file) => {
    if (!files.has(file)) files.set(file, { file, hunks: 0, injections: 0, points: 0 });
    return files.get(file);
  };
  for (const [name, text] of Object.entries(patches)) {
    for (const section of String(text).replaceAll('\r\n', '\n').split(/(?=^diff --git )/m)) {
      if (!section.startsWith('diff --git ') || section.includes('\n--- /dev/null\n')) continue;
      const item = entry(safePath(name, diffPath(name, section)));
      item.hunks += (section.match(/^@@ /gm) || []).length;
      // Standard git diff uses three context lines. Enlarging context must not
      // turn distinct edit locations into one counted injection.
      for (const hunk of section.split(/^@@ .*@@.*\n/gm).slice(1)) {
        let changed = false;
        let context = 0;
        for (const line of hunk.split('\n')) {
          if (line.startsWith(' ')) context++;
          else if (line.startsWith('+') || line.startsWith('-')) {
            if (changed && context > 6) item.hunks++;
            changed = true;
            context = 0;
          }
        }
      }
    }
  }
  // Multiple factories compose in one shim at the same upstream module boundary.
  // That boundary still counts in addition to any textual edits to that file.
  for (const target of moduleBoundaries(patches)) entry(target).injections = 1;
  return [...files.values()].map((item) => ({ ...item, points: item.hunks + item.injections }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

function moduleBoundaries(patches) {
  const targets = new Set();
  for (const [name, text] of Object.entries(patches)) {
    for (const section of String(text).replaceAll('\r\n', '\n').split(/(?=^diff --git )/m)) {
      if (!section.startsWith('diff --git ')) continue;
      const file = safePath(name, diffPath(name, section));
      if (!MANIFESTS.some((manifest) => file === `.personalize/${manifest}`)) continue;
      // Non-owned manifests cannot be safely reconstructed from a diff alone.
      if (!section.includes('\n--- /dev/null\n')) throw new Error(`Manifest must be an owned addition: ${file}`);
      const manifest = JSON.parse(ownedBody(name, file, section));
      if (!Array.isArray(manifest?.modules)) throw new Error(`${file} must contain a modules array`);
      for (const entry of manifest.modules) {
        if (typeof entry?.target !== 'string') throw new Error(`${file} entry without a target`);
        targets.add(safePath(file, entry.target));
      }
    }
  }
  return [...targets].sort();
}

function verifyTitle(text, upstream, expected = TITLE_SHA256) {
  const normalized = String(text).replaceAll('\r\n', '\n');
  if (createHash('sha256').update(normalized).digest('hex') !== expected)
    throw new Error('Mandatory title patch checksum mismatch');
  const targets = new Set(['packages/core/src/session/title.ts', 'packages/core/test/session-title.test.ts']);
  for (const section of normalized.split(/(?=^diff --git )/m).filter(Boolean)) {
    const file = safePath('SessionTitleNaming.patch', diffPath('SessionTitleNaming.patch', section));
    if (!targets.delete(file) || section.includes('\n--- /dev/null\n'))
      throw new Error(`Unexpected mandatory title target: ${file}`);
    if (upstream && !fs.existsSync(path.join(upstream, file))) throw new Error(`Title target missing upstream: ${file}`);
  }
  if (targets.size) throw new Error(`Missing mandatory title target: ${[...targets].join(', ')}`);
}

if (require.main === module) {
  const value = (name) => {
    const i = process.argv.indexOf(name);
    return i < 0 ? undefined : process.argv[i + 1];
  };
  const directory = value('--patches') || path.resolve(__dirname, '../../patches');
  const missing = NAMES.filter((name) => !fs.existsSync(path.join(directory, name)));
  if (missing.includes(MANDATORY)) {
    throw new Error(`Missing mandatory patch in ${directory}: ${MANDATORY}`);
  }
  const permissionPath = path.join(directory, PERMISSIONS);
  if (!fs.existsSync(permissionPath)) throw new Error(`Missing mandatory permission source: ${permissionPath}`);
  if (missing.length > 0) {
    console.error(`WARNING: optional patches missing (checked the rest): ${missing.join(', ')}`);
  }
  const upstream = value('--upstream');
  if (upstream && !fs.existsSync(upstream)) {
    throw new Error(`--upstream directory does not exist: ${upstream}`);
  }
  const patches = Object.fromEntries(
    NAMES.filter((name) => fs.existsSync(path.join(directory, name))).map((name) => [name, fs.readFileSync(path.join(directory, name), 'utf8')])
  );
  const result = analyze(patches, upstream, fs.readFileSync(permissionPath, 'utf8'));
  const titlePath = path.join(directory, 'SessionTitleNaming.patch');
  if (!fs.existsSync(titlePath)) throw new Error(`Missing mandatory title patch: ${titlePath}`);
  verifyTitle(fs.readFileSync(titlePath, 'utf8'), upstream);
  const release = { ...patches, 'SessionTitleNaming.patch': fs.readFileSync(titlePath, 'utf8') };
  const total = footprint(release);
  console.log(
    `Segment integrity checked: ${result.owned} owned files; ${result.permissionFiles} mandatory permission files. Bootstrap alone uses ${result.hunks} hunks; this is not a release-budget approval.`
  );
  console.log(`FULL release upstream footprint (including permissions, titles and upstream tests): ${total.files} existing files, ${total.hunks} hunks.`);
  console.log(`Public-module injection targets: ${moduleBoundaries(release).length}; each counts against its target file's three-point budget.`);
  enforceReleaseBudget(release);
  console.log('Release integration budget PASS: every upstream file has at most 3 edit/injection points across the patch stack.');
}

module.exports = { analyze, footprint, moduleBoundaries, integrationLedger, enforceReleaseBudget, verifyTitle, PERMISSION_FILE_COUNT };
