import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { test } from "node:test"

const source = readFileSync(new URL("../packages/schema/src/personalize/single-executable.ts", import.meta.url), "utf8")
const code = stripTypeScriptTypes(source).replace(/^export /gm, "")
const { singleExecutable, singleExecutableScope } = new Function(`${code}\nreturn { singleExecutable, singleExecutableScope }`)()
const shell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
const node = "C:\\Progs\\node-v24_17\\node.exe"
const git = "Z:\\PortableGit\\cmd\\git.exe"
const canonical = (value) => value[0].toLowerCase() + value.slice(1)

test("the requested Node test invocation reuses the executable when test arguments change", () => {
  const first = "& 'C:/Progs/node-v24_17/node.exe' --test 'D:/Prog/own/mixed/publicgitrepo/ocode/deltav12/personalize-src/base/packages/core/test/permission/service.node.test.mjs'"
  const next = "& 'C:/Progs/node-v24_17/node.exe' --test 'D:/Prog/own/mixed/publicgitrepo/ocode/deltav12/personalize-src/base/.personalize/single-executable.test.mjs'"
  assert.equal(singleExecutable(first, shell), canonical(node))
  assert.equal(singleExecutable(next, shell), singleExecutable(first, shell))
  const firstScope = singleExecutableScope(first, shell)
  assert.notEqual(firstScope.modeKey, singleExecutableScope(next, shell).modeKey)
  assert.equal(firstScope.modeKey, singleExecutableScope(first.replace("service.node.test.mjs", "other.test.mjs"), shell).modeKey)
  assert.notEqual(firstScope.modeKey, singleExecutableScope(first.replace("--test", "--test --watch"), shell).modeKey)
  assert.notEqual(firstScope.modeKey, singleExecutableScope(first.replace("--test", "-e"), shell).modeKey)
})

test("literal full executable paths normalize independently of arguments", () => {
  for (const command of [
    `& '${node}' --version`,
    `& '${node}' -e 'console.log(1);'`,
    `"${node}" --version`,
  ]) {
    assert.equal(singleExecutable(command, shell), command.startsWith("&") ? canonical(node) : undefined)
  }
  assert.equal(singleExecutable(`${git} status --short`, shell), canonical(git))
  assert.equal(singleExecutable(`${git} log --oneline`, "pwsh"), canonical(git))
  assert.equal(singleExecutable(`& "${git.replaceAll("\\", "/")}" 'a|b; c'`, "pwsh.exe"), canonical(git))
  assert.equal(singleExecutable(`& '${node}' -e 'it''s literal'`, shell), canonical(node))
  assert.equal(singleExecutable(`& '${node}' "literal; | & >"`, shell), canonical(node))
  assert.notEqual(singleExecutable("C:\\CaseSensitive\\Node.exe", shell), singleExecutable("C:\\CaseSensitive\\node.exe", shell))
})

test("only unquoted && separators between identical literal targets qualify for SEA", () => {
  for (const command of [
    "git add . && git commit -m xxx && git status",
    'git add .&&git commit -m "docs && tests"&&git status',
    "git commit -m 'it''s fine && done' && git status",
    `& '${git}' add . && & '${git}' status`,
  ]) {
    assert.equal(singleExecutable(command, "pwsh.exe"), command.startsWith("&") ? canonical(git) : "git")
    assert.equal(singleExecutableScope(command, "pwsh.exe", "D:/work"), undefined)
  }
  for (const command of [
    "git status && node --version && git status", "git status && git.exe status",
    "&& git status", "git status &&", "git status && && git status",
    "git status || git log", "git status && git log > out", "git status && $next status",
    'git add . && git commit -m "$(Get-Date)"', "git status && git log | Out-String",
    "git status && git log # && git status", "git status && git log; Get-Date",
    "@'\nprint(1)\n'@ | wsl -d Debian -- python3 -",
  ]) assert.equal(singleExecutable(command, "pwsh.exe"), undefined, command)
})

test("other compound commands and command substitutions are not classified", () => {
  for (const command of [
    `$git='${git}'; & $git status`,
    `${git} status; ${git} log`,
    `${git} status | Out-String`,
    `${git} status > out.txt`,
    `${git} status 2>&1`,
    `${git} $(Get-Location)`,
    `${git} @args`,
    `${git} status # comment`,
    `${git} sta\`tus`,
    `${git} "value \`$(Get-Location)"`,
    `${git} 'unterminated`,
    `${git} 'one'two`,
    `${git} "one""two"`,
    `${git} 'one\u2019; Write-Output injected; #'`,
    `${git} "one\u201d; Write-Output injected; #"`,
    `${git} status\nwhoami`,
    `${git}\tstatus`,
    `${git} status\0`,
    `& & '${git}'`,
  ]) assert.equal(singleExecutable(command, shell), undefined, command)
})

test("ambiguous paths and dynamic command targets are not classified", () => {
  for (const command of [
    "$git status", "& $git status", "C:git.exe status",
    "\\\\server\\share\\git.exe status", "C:\\a\\\\git.exe status",
    "C:\\a\\.\\git.exe status", "C:\\a\\..\\git.exe status",
    "C:\\a.\\git.exe status", "C:\\a\\git.exe:stream status",
    "C:\\a\\*.exe status", "C:\\a\\git?.exe status",
    "& 'C:\\PROGRA~1\\git.exe' status", "C:\\a\\CON.exe status",
    "& 'C:\\a \\git.exe' status",
  ]) assert.equal(singleExecutable(command, shell), undefined, command)
  assert.equal(singleExecutable(`${git} status`, "cmd.exe"), undefined)
  assert.equal(singleExecutable(`${git} status`, "/usr/bin/bash"), undefined)
})

test("ordinary command names and script launchers do not require an exe suffix", () => {
  for (const [command, target] of [
    ["git status --short", "git"],
    ["git --short", "git"],
    ["git add file.txt", "git"],
    ["git.exe add file.txt", "git.exe"],
    ["node script.mjs batch", "node"],
    ["npm.cmd run test", "npm.cmd"],
    [".\\scripts\\check.ps1 -Mode test", ".\\scripts\\check.ps1"],
    ["& 'C:/Tools/runner' --version", "c:\\Tools\\runner"],
    ["& 'C:/Tools/check.ps1' -Mode test", "c:\\Tools\\check.ps1"],
  ]) assert.equal(singleExecutable(command, shell), target, command)
  assert.notEqual(singleExecutable("git status", shell), singleExecutable("git.exe status", shell))
  const scope = (command) => singleExecutableScope(command, shell, "D:/work").modeKey
  assert.equal(scope("git add test/a.ts"), scope("git add test/b.ts"))
  assert.notEqual(scope("git add test/a.ts"), scope("git add src/b.ts"))
  assert.notEqual(scope("git status --short"), scope("git add test/a.ts"))
})

test("SEA accepts the reported Node invocation and scalar argument expansion, not executable substitutions", () => {
  const reported = 'node "$base\\synthetic-transform-profile.mjs" "$base\\diagnostics-gate-detail-01" batch'
  for (const command of [
    reported, 'node "${base}\\profile.mjs" "$env:TEMP\\output" batch',
    'node $script $base\\output batch', `& '${node}' "$base\\profile.mjs"`,
  ]) {
    assert.ok(singleExecutable(command, shell), command)
    assert.equal(singleExecutableScope(command, shell, "D:/work"), undefined, "SE cannot infer a variable's directory")
  }
  for (const command of [
    'node "$($base; whoami)\\profile.mjs"', 'node "$(whoami)"', 'node "`$(whoami)"',
    'node $base.Member', 'node $base[0]', 'node @args', 'node script.mjs; whoami',
    'node "$base\\profile.mjs" | whoami', 'node "$base\\profile.mjs" > out',
    '& "$base\\node.exe" script.mjs', '& (Get-Command node) script.mjs',
  ]) assert.equal(singleExecutable(command, shell), undefined, command)
})

test("scope fixes ordinary argv and allows basenames only within the same parent", () => {
  const cwd = "D:\\project"
  const scope = (args, directory = cwd, exe = git) => singleExecutableScope(`& '${exe}' ${args}`, shell, directory)
  const first = scope("vitest --test test/a.ts")
  assert.equal(first.executable, canonical(git))
  assert.deepEqual(first.arguments, ["vitest", "--test", "test/a.ts"])
  assert.equal(first.modeKey, scope("vitest --test 'test/b.ts'").modeKey)
  assert.notEqual(first.modeKey, scope("vitest --test src/x.ts").modeKey)
  assert.notEqual(first.modeKey, scope("vitest --test test/a.ts", "D:\\other").modeKey)
  assert.notEqual(first.modeKey, scope("build --test test/a.ts").modeKey)
  assert.notEqual(first.modeKey, scope("vitest -e test/a.ts").modeKey)
  assert.notEqual(scope("run build").modeKey, scope("run test").modeKey)
  assert.notEqual(scope("status").modeKey, scope("log").modeKey)
  assert.equal(scope("--file=test/a.ts").modeKey, scope("--file=test/b.ts").modeKey)
  assert.notEqual(scope("--file=test/a.ts").modeKey, scope("--file=src/b.ts").modeKey)
  assert.notEqual(scope("--file=test/a.ts").modeKey, scope("--other=test/a.ts").modeKey)
  assert.equal(scope("--test test/a.ts", cwd, node).modeKey, scope("--test test/b.ts", cwd, node).modeKey)
  assert.notEqual(scope("--test test/a.ts", cwd, node).executable, first.executable)
})

test("absolute paths scope by parent; ambiguous and unresolved paths stay exact", () => {
  const scope = (arg, cwd) => singleExecutableScope(`& '${node}' --test '${arg}'`, shell, cwd).modeKey
  assert.equal(scope("D:/tests/a.mjs"), scope("d:\\tests\\b.mjs"))
  assert.notEqual(scope("D:/tests/a.mjs"), scope("D:/other/a.mjs"))
  assert.notEqual(scope("test/a.ts"), scope("test/b.ts"))
  assert.notEqual(scope("../test/a.ts", "D:\\project"), scope("../test/b.ts", "D:\\project"))
  assert.notEqual(scope("test/CON.ts", "D:\\project"), scope("test/b.ts", "D:\\project"))
  assert.notEqual(scope("test/a.ts:stream", "D:\\project"), scope("test/b.ts:stream", "D:\\project"))
  assert.notEqual(scope("D:/work/test"), scope("D:/work/src"))
  assert.notEqual(scope("D:/work/test/"), scope("D:/work/src/"))
  assert.notEqual(scope("test/root", "D:\\project"), scope("src/root", "D:\\project"))
  assert.notEqual(scope("process.exitCode=1", "D:\\project"), scope("process.exitCode=2", "D:\\project"))
  assert.notEqual(scope("run first.test.js", "D:\\project"), scope("run second.test.js", "D:\\project"))
  assert.equal(scope("a.ts", "D:\\project\\"), scope("b.ts", "D:\\project"))
})

test("scope shares the existing conservative command grammar", () => {
  for (const command of [
    `${git} status; ${git} log`, `${git} $args`, `${git} 'a\u2019b'`,
    `& '${node}' --test test/*.mjs`, `${git} status\nwhoami`,
  ]) assert.equal(singleExecutableScope(command, shell, "D:\\project"), undefined, command)
  assert.equal(singleExecutableScope(`${git} status`, "cmd.exe"), undefined)
})
