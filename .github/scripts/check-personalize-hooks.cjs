'use strict';

// Enforces the personalization isolation contract on the generated patch set:
//   * at most FOUR upstream hook hunks, all inside packages/cli/script/build.ts;
//   * everything else ships as OWNED new files (no renames, no binary sections,
//     no path traversal, no collisions with upstream files);
//   * every manifest entry's owned modules are actually delivered by the patches;
//   * the build shim (.personalize/build.mjs) is delivered whenever any manifest is;
//   * the one allowed hook actually loads the owned boundaries (a build.ts edit
//     that ignores them would silently ship inert owned modules);
//   * with --upstream: declared exports and every `stock.X` access in a factory
//     still resolve to public exports of the LIVE upstream module.
//
// No subset mode on purpose: the budget only means anything when every patch in
// the set is counted.

const fs = require('node:fs');
const path = require('node:path');

const NAMES = ['FinalPERSONALIZE.patch', 'FinalPersonalizeR.patch', 'FinalPersonalizeS.patch', 'FinalPersonalizeX.patch'];
const MANDATORY = 'FinalPERSONALIZE.patch';
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

function analyze(patches, upstream) {
  const hooks = [];
  const additions = new Map();
  for (const [name, text] of Object.entries(patches)) {
    for (const section of String(text)
      .replaceAll('\r\n', '\n')
      .split(/(?=^diff --git )/m)
      .filter((s) => s.startsWith('diff --git '))) {
      const file = safePath(name, diffPath(name, section));
      if (section.includes('\n--- /dev/null\n')) {
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
  if (hunks > 4) throw new Error(`Maximum four upstream hook points; found ${hunks}`);

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
  if (delivered.length > 0 && hunks > 0) {
    const wired = hooks.some((entry) =>
      addedLines(entry.section, entry.file).some((line) => line.includes('.personalize/build.mjs') || line.includes('PersonalizeBuild'))
    );
    if (!wired) throw new Error('The allowed build hook does not load the owned module boundaries');
  }
  return { files: new Set(hooks.map((h) => h.file)).size, hunks, owned: additions.size };
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
  const result = analyze(patches, upstream);
  console.log(
    `Personalize hook budget PASS: ${result.hunks}/4 hook points across ${result.files} upstream file, ${result.owned} owned files.`
  );
}

module.exports = { analyze };
