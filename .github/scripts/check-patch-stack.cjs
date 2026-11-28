'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Same order as the release, including the separately applied title patch.
const ORDER = ['FinalPERSONALIZE.patch', 'FinalPersonalizeX.patch', 'FinalPersonalizeS.patch',
  'FinalPersonalizeR.patch', 'SessionTitleNaming.patch'];

function checkPatchStack({ upstream, directory, git = process.env.PERSONALIZE_GIT || 'git' }) {
  upstream = path.resolve(upstream);
  directory = path.resolve(directory);
  const names = ORDER.filter((name) => fs.existsSync(path.join(directory, name)));
  for (const name of [ORDER[0], ORDER.at(-1)])
    if (!names.includes(name)) throw new Error(`Missing mandatory release patch: ${name}`);
  // Never inherit another operation's index, worktree, object store or config.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  env.GIT_TERMINAL_PROMPT = '0';
  const run = (cwd, args) => {
    const result = spawnSync(git, ['-c', 'core.autocrlf=false', '-c', 'core.filemode=false',
      '-c', `safe.directory=${cwd.replaceAll('\\', '/')}`, '-C', cwd, ...args],
    { env, maxBuffer: 32 * 1024 * 1024 });
    if (result.error || result.status !== 0)
      throw new Error(`${args.join(' ')}\n${result.error?.message || result.stderr?.toString() || `exit ${result.status}`}`);
    return result.stdout;
  };
  const revision = run(upstream, ['rev-parse', '--verify', 'HEAD^{commit}']).toString().trim();
  const targets = new Set();
  for (const name of names) {
    const text = fs.readFileSync(path.join(directory, name), 'utf8');
    let count = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('diff --git ')) continue;
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!match || match[1] !== match[2] || path.isAbsolute(match[1]) || /[\\\0\r\n]/.test(match[1]) ||
        match[1].split('/').some((part) => !part || part === '.' || part === '..'))
        throw new Error(`${name}: unsupported patch path: ${line}`);
      targets.add(match[1]);
      count++;
    }
    if (!count) throw new Error(`${name}: no patch sections`);
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-patch-stack-'));
  try {
    // Seed every touched path from the exact commit, including any collisions
    // with claimed new files. No source checkout/index/ref is modified. Untouched
    // files cannot affect textual application, so no full clone is needed.
    const entries = run(upstream, ['ls-tree', '-rz', revision, '--', ...targets]).toString().split('\0').filter(Boolean);
    const executable = [];
    for (const entry of entries) {
      const match = /^(\d+) blob ([0-9a-f]+)\t(.+)$/.exec(entry);
      if (!match || !['100644', '100755'].includes(match[1]))
        throw new Error(`Unsupported upstream patch target: ${entry}`);
      const file = match[3];
      fs.mkdirSync(path.dirname(path.join(temporary, file)), { recursive: true });
      fs.writeFileSync(path.join(temporary, file), run(upstream, ['cat-file', 'blob', match[2]]));
      if (match[1] === '100755') executable.push(file);
    }
    run(temporary, ['init', '--quiet']);
    run(temporary, ['add', '--all']);
    for (const file of executable) run(temporary, ['update-index', '--chmod=+x', '--', file]);
    for (const name of names) {
      try {
        // A check of each patch against pristine HEAD misses cross-patch effects.
        // Apply sequentially to a disposable index and tree, exactly like release.
        run(temporary, ['apply', '--index', '--whitespace=nowarn', '--', path.join(directory, name)]);
      } catch (error) {
        throw new Error(`Release patch compatibility FAILED at upstream ${revision}: ${name}\n${error.message}`);
      }
    }
    return { revision, patches: names };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const value = (name) => process.argv[process.argv.indexOf(name) + 1];
  if (!process.argv.includes('--upstream')) throw new Error('--upstream is required');
  const result = checkPatchStack({
    upstream: value('--upstream'),
    directory: process.argv.includes('--patches') ? value('--patches') : path.resolve(__dirname, '../../patches'),
  });
  console.log(`Indexed release stack PASS: ${result.patches.length} patches at upstream ${result.revision}`);
}

module.exports = { checkPatchStack, ORDER };
