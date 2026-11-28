import assert from "node:assert/strict"
import { readFileSync, existsSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { createHash } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const root = fileURLToPath(new URL("../", import.meta.url))
const source = process.env.PERSONALIZE_SOURCE ?? root
function load(file, dependencies) {
  const code = stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "transform" })
    .replace(/^export \* as \w+ from ["'][^"']+["'];?$/gm, "")
    .replace(/^import (\w+) from ["']([^"']+)["'];?$/gm,
      (_, name, specifier) => `const ${name} = dependencies[${JSON.stringify(specifier)}];`)
    .replace(/^import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["'];?$/gm,
      (_, fields, name) => `const {${fields.replace(/\bas\b/g, ":")}} = dependencies[${JSON.stringify(name)}];`)
  const names = [...code.matchAll(/^export (?:const|function|class) (\w+)/gm)].map((match) => match[1])
  return new Function("dependencies", `${code.replace(/^export /gm, "")}\nreturn {${names.join(",")}}`)(dependencies)
}
const parserFile = path.join(source, "packages/schema/src/permission-shorthand.ts")
assert.ok(existsSync(parserFile), "PERSONALIZE_SOURCE must identify the delivered permission parser; do not silently skip")
const parser = load(parserFile, {})
const executable = load(path.join(root, "packages/schema/src/personalize/single-executable.ts"), {})
const policy = load(path.join(root, "packages/schema/src/personalize/permission-policy.ts"), {
  "../permission-shorthand.js": parser,
  "./single-executable.js": executable,
  "./zip-entry-read.js": load(path.join(root, "packages/schema/src/personalize/zip-entry-read.ts"), {}),
})
const { createPermissionController } = load(path.join(root, "packages/schema/src/personalize/permission-controller.ts"), {
  "./permission-policy.js": policy,
})
const grants = load(path.join(root, "packages/core/src/permission/session-grant.ts"), {
  "node:path": path,
  "@opencode/schema/personalize/permission-policy": policy,
})
const { wholeCommandPattern } = load(path.join(root, "packages/core/src/personalize/whole-command.ts"), {
  "../shell/scan.js": load(path.join(source, "packages/core/src/shell/scan.ts"), {}),
})
const engine = load(path.join(root, "packages/core/src/personalize/permission-policy.ts"), {
  "./whole-command.js": { wholeCommandPattern },
  "node:crypto": { createHash },
  "node:path": path,
  "drizzle-orm": {},
  effect: {},
  "@opencode/schema/personalize/permission-policy": policy,
  "@opencode/schema/session-event": {},
  "../event/sql.js": {},
  "../permission/session-grant.js": { SessionGrant: grants },
  "../permission/policy.js": {},
})
// These cases exercise the pure facts encoder, not the Effect-backed factories.
const { filesystemMetadata } = load(path.join(root, "packages/core/src/personalize/filesystem-permission.ts"), {
  "node:path": path,
  effect: {},
  "@opencode/schema/personalize/permission-policy": policy,
  "../environment/index.js": {},
  "../file-access.js": {},
  "../schema.js": {},
  "../permission.js": {},
})
const facts = { operations: ["read", "update"], paths: ["D:/data/a"], directories: ["D:/data"], access: "content" }
const request = (extra = {}) => ({
  id: "per_test", sessionID: "ses_test", action: "read", resources: ["D:/data/a"], ...extra,
})
const unknown = () => request({
  action: "shell", save: ["*"],
  message: "Unknown effects: this command may bypass filesystem denies.",
  metadata: { filesystemEffects: "unknown" },
})
const pending = () => {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

test("read metadata never stats a cold environment before approval", async () => {
  const { Effect } = await import(process.env.PERSONALIZE_EFFECT ?? "effect")
  const { filesystemReadMetadata, externalMetadata } = load(
    path.join(root, "packages/core/src/personalize/filesystem-permission.ts"), {
      "node:path": path, effect: { Effect },
      "@opencode/schema/personalize/permission-policy": policy,
      "../environment/index.js": {}, "../file-access.js": {}, "../permission.js": {},
    },
  )
  let stats = 0
  const target = {
    absolute: "/sandbox/dir", machine: "wrk_test",
    externalDirectory: { directory: "/sandbox/dir", resource: "wrk_test:/sandbox/dir" },
    environment: { id: "wrk_test", path: path.posix, files: {
      stat: () => Effect.sync(() => { stats++; return { type: "directory" } }),
    } },
  }
  const cold = await Effect.runPromise(filesystemReadMetadata(target, { ready: () => Effect.succeed(false) }))
  assert.equal(stats, 0)
  assert.equal(policy.readFacts({ metadata: cold }).access, "content")
  const warm = await Effect.runPromise(filesystemReadMetadata(target, { ready: () => Effect.succeed(true) }))
  assert.equal(stats, 1)
  assert.equal(policy.readFacts({ metadata: warm }).access, "listing")
  const internal = { ...target, absolute: "/sandbox/internal", externalDirectory: undefined }
  const metadata = filesystemMetadata([internal, target], ["read"], "content")
  assert.deepEqual(policy.readFacts({ metadata: externalMetadata([internal, target], metadata) }).paths, [target.absolute])
})

test("write authorization respects caller-owned external access and rechecks changed CRUD kinds", async () => {
  const { Effect } = await import(process.env.PERSONALIZE_EFFECT ?? "effect")
  const { makeFileWritePermissions } = load(
    path.join(root, "packages/core/src/personalize/filesystem-permission.ts"), {
      "node:path": path, effect: { Effect },
      "@opencode/schema/personalize/permission-policy": policy,
      "../environment/index.js": {},
      "../file-access.js": { FileAccess: { always: (target) => target.resource } },
      "../permission.js": { Permission: { invocation: (context) => context } },
    },
  )
  let exists = false
  const target = {
    absolute: "/srv/file", resource: "pro:/srv/file", machine: "pro",
    externalDirectory: { directory: "/srv" },
    environment: { path: path.posix, files: {
      stat: () => Effect.suspend(() => exists ? Effect.succeed({ type: "file" })
        : Effect.fail({ _tag: "Environment.NotFound" })),
    } },
  }
  const events = []
  const write = makeFileWritePermissions({
    access: {
      resolve: () => Effect.succeed(target),
      authorizeExternal: (_targets, _context, metadata) => Effect.sync(() => {
        events.push({ type: "external", facts: policy.readFacts({ metadata }) })
      }),
    },
    permission: { assert: (input) => Effect.sync(() => {
      events.push({ type: input.action, facts: policy.readFacts(input) })
    }) },
  })
  const context = { sessionID: "ses_write" }
  // A transfer has already authorized its endpoints using FileAccess.
  await Effect.runPromise(write.authorize(target, context))
  assert.deepEqual(events.map((event) => event.type), ["edit"])
  assert.deepEqual(events[0].facts.operations, ["create"])
  assert.equal(events[0].facts.machine, "pro")
  events.length = 0
  await Effect.runPromise(write.target(target.resource, context))
  await Effect.runPromise(write.authorize(target, context))
  assert.deepEqual(events.map((event) => event.type), ["external", "edit"])
  events.length = 0
  exists = true
  await Effect.runPromise(write.authorize(target, context))
  assert.deepEqual(events.map((event) => event.type), ["external", "edit"])
  assert.ok(events.every((event) => event.facts.operations.join() === "update"))
})

test("machine-qualified metadata and persisted grants cannot alias local directories", () => {
  const local = policy.withFacts(request(), facts)
  const remote = policy.withFacts(request(), { ...facts, machine: "gpu" })
  assert.deepEqual(policy.policyDirectories(remote), ["gpu:D:/data"])
  const selection = { operation: "read", effect: "allow", lifetime: "session", recursive: true, scope: "selected" }
  const grant = { ...selection, directory: "D:/data", machine: "gpu" }
  assert.deepEqual(grants.decode([grants.encode(grant)]), [grant])
  const read = value => policy.withFacts(request(), { ...facts, operations: ["read"], ...value })
  assert.equal(grants.decision([grant], read({ machine: "gpu" })), "allow")
  assert.equal(grants.decision([grant], read({})), undefined)
  assert.equal(grants.decision([grant], read({ machine: "other" })), undefined)
  const localGrant = { ...selection, directory: "D:/data" }
  assert.equal(engine.mergeGrants([grants.encode(localGrant)], [grant]).length, 2)
  assert.throws(() => policy.readFacts(policy.withFacts(request(), { ...facts, machine: "" })), /Invalid/)
  assert.throws(() => grants.decode([grants.encode({ ...grant, machine: 1 })]), /Invalid/)
  assert.equal(policy.readFacts(local).machine, undefined)
  assert.throws(() => filesystemMetadata([
    { absolute: "D:/data/a", machine: "gpu", environment: {} },
    { absolute: "D:/data/b", environment: {} },
  ], ["read"]), /different machines/)
})

test("stock metadata alone round-trips the owned facts without SDK fields", () => {
  const input = policy.withFacts(request({ metadata: { input: { path: "a" } } }), facts)
  const wire = JSON.parse(JSON.stringify({
    id: input.id, sessionID: input.sessionID, action: input.action, resources: input.resources, metadata: input.metadata,
  }))
  assert.deepEqual(policy.readFacts(wire), facts)
  assert.deepEqual(wire.metadata.input, { path: "a" })
  assert.equal(wire.operations, undefined)
  assert.equal(wire.paths, undefined)
  assert.equal(wire.directories, undefined)
})

test("metadata encoding neither mutates input nor shares mutable fact arrays", () => {
  const input = request({ metadata: { other: true } })
  const mutable = { ...facts, paths: [...facts.paths] }
  const encoded = policy.withFacts(input, mutable)
  mutable.paths[0] = "D:/other"
  assert.deepEqual(input.metadata, { other: true })
  assert.deepEqual(policy.readFacts(encoded).paths, facts.paths)
})

test("malformed or contradictory owned facts are rejected, never silently ignored", () => {
  for (const bad of [null, {}, { ...facts, operations: [] }, { ...facts, operations: ["execute"] },
    { ...facts, operations: ["read", "read"] }, { ...facts, paths: [] }, { ...facts, access: "anything" }]) {
    assert.throws(() => policy.readFacts(request({ metadata: { [policy.metadataKey]: bad } })), /Invalid filesystem/)
  }
  const encoded = policy.withFacts(request(), facts)
  assert.throws(() => policy.readFacts({ ...encoded, ...facts, paths: ["D:/other"] }), /Conflicting/)
  assert.throws(() => policy.withFacts(encoded, { ...facts, operations: ["delete"] }), /Conflicting/)
})

test("unclassified legacy external requests never manufacture CRUD operations", () => {
  const value = request({ action: "external_directory", paths: ["D:/data"], directories: ["D:/data"] })
  assert.equal(policy.readFacts(value), undefined)
  assert.deepEqual(policy.choices(value), ["once", "reject"])
  assert.deepEqual(policy.policyDirectories(value), ["D:/data"])
})

test("unknown shell choices and editor describe command approval", () => {
  const value = unknown()
  assert.deepEqual(policy.choices(value), ["once", "policy", "reject"])
  assert.deepEqual(policy.choices(value).map((choice) => policy.choiceLabel(choice, true, (option) => option)),
    ["=1", "Custom", "=Deny"])
  assert.equal(policy.policyEditor(value).title, "Unknown command policy")
  assert.equal(policy.policyEditor(value).placeholder, "Unknown=1")
  const script = executableRequest("$env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1'\ndotnet run")
  assert.deepEqual(policy.choices(script), ["once", "policy", "Unknown=S", "reject"])
  assert.equal(policy.policyEditor(script).placeholder, "Unknown=1 / Unknown=S / Whole=SEA")
  assert.deepEqual(policy.parsePolicy(" whole=sea ", true), { kind: "unknown", lifetime: "session", scope: "whole" })
  assert.equal(policy.policyError("Whole=SEA", true, script), undefined)
  assert.match(policy.policyError("Whole=SEA*", true, script), /no wildcard/)
  assert.ok(policy.policyError("Whole=SEA", false, request()))
})

test("one-shot and exact session unknown policies share one parser and reject wildcards", () => {
  assert.deepEqual(policy.parsePolicy(" Unknown=1 ", true), { kind: "unknown", lifetime: "once" })
  assert.deepEqual(policy.parsePolicy("unknown=s", true), { kind: "unknown", lifetime: "session" })
  assert.deepEqual(policy.parsePolicy("Unknown=SE", true), { kind: "unknown", lifetime: "session", scope: "executable" })
  assert.deepEqual(policy.parsePolicy("Unknown=SEA", true), { kind: "unknown", lifetime: "session", scope: "executable-all" })
  for (const text of ["Unknown=S*", "Unknown=E", "Unknown=E*", "Unknown=SE*", "Unknown=SEA*", "Unknown=1*", "Unknown=S R=S*", ""])
    assert.match(policy.policyError(text, true), /no wildcard/)
})

test("Custom submits only a filled slot; blanks and ambiguous replies never approve", () => {
  const value = executableRequest("git status")
  const initial = policy.policyEditor(value).initial
  assert.equal(initial, "Unknown= Whole=")
  assert.equal(policy.policyEditor(unknown()).initial, "Unknown=")
  assert.equal(policy.policyEditor(request()).initial, "")
  for (const text of ["", "  ", initial, "Unknown=S Whole=SEA", "Unknown=S* Whole="]) {
    const controller = createPermissionController(value, { send() { assert.fail("unexpected permission reply") } })
    controller.open("policy")
    assert.equal(controller.submitPolicy(text), false)
    assert.equal(controller.getState().stage, policy.policyDraft(text, true) ? "policy" : "permission")
    assert.equal(controller.getState().attempt, 0)
  }
  for (const [draft, expected] of [["Unknown=SEA Whole=", "Unknown=SEA"], ["Unknown= Whole=SEA", "Whole=SEA"]]) {
    const replies = []
    const controller = createPermissionController(value, { send: (reply) => replies.push(reply) })
    controller.open("policy")
    assert.equal(controller.submitPolicy(draft), true)
    assert.deepEqual(replies.map(({ decision }) => decision), [{ scope: "session", policy: expected }])
  }
})

test("v11 CRUD choice precedes read shortcut; shell CRUD and execution approval remain separate", () => {
  const read = policy.withFacts(request(), { ...facts, operations: ["read"] })
  assert.deepEqual(policy.choices(read), ["once", "policy", "session_read", "reject"])
  const value = executableRequest("[IO.File]::ReadAllBytes($p)")
  assert.deepEqual(policy.policyDirectories(value), [value.metadata.unknownCwd])
  const sent = []
  const controller = createPermissionController(value, { send: (reply) => { sent.push(reply) } })
  assert.equal(controller.submit({ scope: "session", policy: "RU=S* CD=D*" }), true, controller.getState().error)
  assert.equal(sent[0].decision.policy, "RU=S* CD=D*")
  assert.equal(policy.parsePolicy("RU=S* CD=D*", true).kind, "filesystem")
  assert.match(policy.policyError("R=1", true, value), /require =S or =D/)
  controller.dispose()
})

const executableRequest = (command, extra = {}) => request({
  action: "shell",
  metadata: {
    filesystemEffects: "unknown",
    unknownCommand: command,
    unknownCwd: "D:/work",
    unknownShell: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    ...extra,
  },
})

test("SEA approvals vary arguments but remain exact to executable/session/cwd/shell/denies", () => {
  const first = executableRequest("& 'Z:/PortableGit/cmd/git.exe' status")
  const second = executableRequest("& 'z:\\PortableGit\\cmd\\git.exe' diff --no-index -- 'a' 'b'")
  const key = engine.unknownExecutableKey(first, [], "executable-all")
  assert.equal(typeof key, "string")
  assert.equal(engine.unknownExecutableKey(second, [], "executable-all"), key)
  assert.notEqual(engine.unknownKey(first, []), engine.unknownKey(second, []), "Unknown=S must remain exact")
  for (const value of [
    { ...first, sessionID: "ses_other" },
    executableRequest(first.metadata.unknownCommand, { unknownCwd: "D:/other" }),
    executableRequest(first.metadata.unknownCommand, { unknownShell: "C:/Program Files/PowerShell/7/pwsh.exe" }),
    executableRequest("& 'D:/other/git.exe' status"),
  ]) assert.notEqual(engine.unknownExecutableKey(value, [], "executable-all"), key)
  const deny = {
    directory: "D:/private", operation: "delete", effect: "deny", lifetime: "session", scope: "selected", recursive: true,
  }
  assert.notEqual(engine.unknownExecutableKey(first, [deny], "executable-all"), key)
  assert.match(policy.policyEditor(first).hint, /any arguments/)
  assert.ok(policy.policyEditor(first).hint.includes("z:\\PortableGit\\cmd\\git.exe"))
  assert.equal(policy.policyEditor(first).placeholder, "Unknown=1 / Unknown=S / Unknown=SE / Unknown=SEA / Whole=SEA")
})

test("reserved unknown records are validated and explicit denial wins", () => {
  const key = "a".repeat(64)
  const rule = (effect) => ({ action: engine.UNKNOWN_ACTION, resource: key, effect })
  assert.equal(engine.unknownDecision([rule("allow")], [key]), "allow")
  assert.equal(engine.unknownDecision([rule("deny"), rule("allow")], [key]), "deny")
  assert.equal(engine.unknownDecision([rule("allow"), rule("ask")], [key]), "ask")
  assert.equal(engine.unknownDecision([rule("allow")], [], [key]), undefined)
  const chainKey = "a".repeat(64)
  const chainAllow = { ...rule("allow"), resource: chainKey }
  for (const restriction of ["ask", "deny"]) {
    assert.equal(engine.unknownDecision([chainAllow, rule(restriction)], [chainKey], [key]), restriction)
  }
  assert.throws(() => engine.unknownDecision([{ ...rule("allow"), resource: "*" }], [key]), /Invalid stored/)
  assert.throws(() => engine.unknownDecision([rule("anything")], [key]), /Invalid stored/)
})

test("SE keeps argument structure and path parents while SEA explicitly permits all arguments", () => {
  const first = executableRequest("& 'C:/Progs/node-v24_17/node.exe' --test 'D:/work/test/a.test.mjs'")
  const same = executableRequest("& 'C:/Progs/node-v24_17/node.exe' --test 'D:/work/test/b.test.mjs'")
  const key = engine.unknownExecutableKey(first, [])
  assert.equal(typeof key, "string")
  assert.equal(engine.unknownExecutableKey(same, []), key)
  const multiple = executableRequest("& 'C:/Progs/node-v24_17/node.exe' --test 'D:/work/test/b.test.mjs' 'D:/work/test/c.test.mjs'")
  assert.equal(engine.unknownExecutableKey(multiple, []), key)
  assert.notEqual(engine.unknownExecutableKey(first, [], "executable-all"), key)
  for (const command of [
    "& 'C:/Progs/node-v24_17/node.exe' --test 'D:/work/src/b.test.mjs'",
    "& 'C:/Progs/node-v24_17/node.exe' build 'D:/work/test/b.test.mjs'",
    "& 'C:/Progs/node-v24_17/node.exe' -e 'D:/work/test/b.test.mjs'",
    "& 'C:/Progs/node-v24_17/node.exe' --test --watch 'D:/work/test/b.test.mjs'",
    "& 'C:/Progs/node-v24_17/node.exe' --test 'D:/work/test/b.test.mjs' 'D:/work/src/c.test.mjs'",
  ]) assert.notEqual(engine.unknownExecutableKey(executableRequest(command), []), key)
  assert.notEqual(engine.unknownExecutableKey(executableRequest(first.metadata.unknownCommand, { unknownCwd: "D:/other" }), []), key)
  assert.notEqual(engine.unknownExecutableKey({ ...first, sessionID: "ses_other" }, []), key)
  assert.notEqual(engine.unknownExecutableKey(first, [{
    directory: "D:/private", operation: "delete", effect: "deny", lifetime: "session", scope: "selected", recursive: true,
  }]), key)
})

test("compound or dynamic-target commands cannot obtain a command grant or reach the backend through SE/SEA", () => {
  for (const command of [
    "$git = 'Z:/PortableGit/cmd/git.exe'; & $git status",
    "& 'Z:/PortableGit/cmd/git.exe' status; Write-Output done",
    "& 'Z:/PortableGit/cmd/git.exe' diff | Out-File result",
    "& 'Z:/PortableGit/cmd/git.exe' status > result",
    "& 'Z:/PortableGit/cmd/git.exe' $(Get-Content args)",
    '& "$base/node.exe" script.mjs',
    'node "$(Get-Content args)"',
  ]) {
    const value = executableRequest(command)
    assert.equal(engine.unknownExecutableKey(value, []), undefined)
    for (const text of ["Unknown=SE", "Unknown=SEA"]) {
      let sent = 0
      const controller = createPermissionController(value, { send: () => { sent++ } })
      assert.equal(controller.submit({ scope: "session", policy: text }), false)
      assert.equal(sent, 0)
      assert.match(controller.getState().error, /one command with a literal name or path/)
      controller.dispose()
    }
  }
})

test("git names and the reported Node variable arguments reach the backend with the requested scope", () => {
  for (const [command, text] of [
    ["git status --short", "Unknown=SE"],
    ["git add file.txt", "Unknown=SEA"],
    ['node "$base\\synthetic-transform-profile.mjs" "$base\\diagnostics-gate-detail-01" batch', "Unknown=SEA"],
  ]) {
    const value = executableRequest(command)
    const sent = []
    const controller = createPermissionController(value, { send: (reply) => { sent.push(reply) } })
    assert.equal(controller.submit({ scope: "session", policy: text }), true, controller.getState().error)
    assert.equal(sent.length, 1)
    assert.ok(engine.unknownExecutableKey(value, [], text === "Unknown=SE" ? "executable" : "executable-all"))
    controller.dispose()
  }
  const node = executableRequest('node "$base\\profile.mjs" batch')
  assert.match(policy.policyError("Unknown=SE", true, node), /Use Unknown=SEA/)
  const key = engine.unknownExecutableKey(node, [], "executable-all")
  assert.equal(key, engine.unknownExecutableKey(executableRequest("node other.mjs next"), [], "executable-all"))
  assert.notEqual(key, engine.unknownExecutableKey(executableRequest("git status"), [], "executable-all"))
  const lookup = (value) => engine.unknownExecutableKey(executableRequest("git status", { unknownLookup: value }), [], "executable-all")
  assert.notEqual(lookup("first-environment"), lookup("second-environment"))
})

test("Whole=SEA compares complete scripts including their control flow, redirections and command targets", () => {
  const pattern = (command, shell = "pwsh.exe") => wholeCommandPattern(command, shell).pattern
  const loop = "foreach ($d in @(Get-ChildItem -Directory)) { Move-Item -LiteralPath $d.FullName -Destination 'D:/archive' }"
  assert.deepEqual(pattern(loop), pattern(loop.replace("-Directory", "-Directory -Force").replace("'D:/archive'", '"D:\\other folder"')))
  for (const changed of [loop.replace("Move-Item", "Copy-Item"), loop.replace("foreach", "while"),
    loop + "; Get-Date", loop.replace("'D:/archive'", "$(Get-Date)"), "Move-Item a b"]) {
    assert.notDeepEqual(pattern(changed), pattern(loop))
  }
  const a = "git status && node scan.js"
  for (const shell of ["pwsh.exe", "/bin/bash"]) {
    assert.deepEqual(pattern(a, shell), pattern("git diff --stat && node other.js batch", shell))
    for (const changed of ["git status | node scan.js", "node scan.js && git status", "git status",
      "git status && node scan.js > log", "git status && node scan.js && node scan.js"])
      assert.notDeepEqual(pattern(a, shell), pattern(changed, shell))
  }
  assert.notDeepEqual(pattern("git log > first"), pattern("git log > second"))
  assert.notDeepEqual(pattern("$env:TEST='a'; git log"), pattern("$env:TEST='b'; git log"))
  assert.notDeepEqual(pattern("echo 'git status'; git status"), pattern("echo 'git status'; git status; whoami"))
})

test("SEA can be selected on the whole Git chain and uses the standalone Git grant key", () => {
  const chain = executableRequest("git add . && git commit -m xxx && git status")
  const sent = []
  const controller = createPermissionController(chain, { send: (reply) => { sent.push(reply) } })
  assert.equal(controller.submit({ scope: "session", policy: "Unknown=SE" }), false)
  assert.equal(controller.submit({ scope: "session", policy: "Unknown=SEA" }), true)
  assert.equal(sent.length, 1)
  const key = engine.unknownExecutableKey(chain, [], "executable-all")
  assert.equal(typeof key, "string")
  assert.equal(key, engine.unknownExecutableKey(executableRequest("git add ."), [], "executable-all"))
  assert.equal(engine.unknownExecutableKey(chain, []), undefined)
  controller.dispose()
})

test("ZIP read grants follow bound receivers and vary only archive and entry data at SEA scope", () => {
  const file = "D:/some folder/example.zip"
  const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [IO.Compression.ZipFile]::OpenRead('${file}')
try {
  $e = $z.GetEntry('nested/one.json')
  $s = $e.Open()
  $r = [IO.StreamReader]::new($s)
  try { $r.ReadToEnd() | ConvertFrom-Json } finally { $r.Dispose() }
} finally { $z.Dispose() }`
  const compact = `$file = '${file}'; $name = 'nested/one.json'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($file)
try {
  $reader = [System.IO.StreamReader]::new($archive.GetEntry($name).Open())
  try { $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
} finally { $archive.Dispose() }`
  const requestFor = (command) => executableRequest(command, { unknownCwd: "D:/work" })
  const key = (command) => engine.unknownExecutableKey(requestFor(command), [], "executable-all")
  const approved = key(script)
  assert.equal(typeof approved, "string")
  assert.equal(key(compact), approved)
  assert.equal(key(script.replace(file, "E:/other/O''Brien.zip").replace("nested/one.json", "a;b/two.json")), approved)
  assert.notEqual(key(script.replace(" | ConvertFrom-Json", "")), approved)
  assert.notEqual(engine.unknownKey(requestFor(script), []), engine.unknownKey(requestFor(compact), []))
  assert.equal(engine.unknownExecutableKey(requestFor(compact), []), undefined)
  assert.match(policy.policyError("Unknown=SE", true, requestFor(script)), /literal name or path/)
  assert.equal(policy.policyError("Unknown=SEA", true, requestFor(script)), undefined)
  assert.equal(policy.policyEditor(requestFor(script)).placeholder, "Unknown=1 / Unknown=S / Unknown=SEA / Whole=SEA")
  for (const changed of [
    script + "\nSet-Content log data", script.replace("ReadToEnd()", "ReadToEnd() > out"),
    script.replace("$e.Open()", "$other.Open()"), script.replace("OpenRead(", "OpenWrite("),
    script.replace("$e.Open()", "$e.Delete()"), script.replace(" | ConvertFrom-Json", " | Invoke-Expression"),
    script.replace(`'${file}'`, "$env:ARCHIVE"), script.replace(file, "D:/files/../private/a.zip"),
    script.replace(file, "D:/files/a.zip:stream.zip"), script.replace(file, "//server/share/a.zip"),
    script.replace("nested/one.json", "x'); Set-Content out x; ('x"),
    script.replace("System.IO.Compression.FileSystem", "$assembly"),
    compact.replace("$name = 'nested/one.json'", "$name = (Get-Content name.txt)"),
  ]) assert.equal(key(changed), undefined, changed)
})

test("filesystem validation preserves omitted operations and rejects MCP or contradictory policies", () => {
  const value = policy.parsePolicy("RU=S* CD=D*", false)
  assert.deepEqual(value.rules.map(({ operation, effect, recursive }) => [operation, effect, recursive]),
    [["read", "allow", true], ["update", "allow", true], ["create", "deny", true], ["delete", "deny", true]])
  assert.equal(policy.parsePolicy("R=-S", false).rules.length, 1)
  for (const text of ["", "R=S* R=D*", "MCP:=playwright"])
    assert.equal(typeof policy.policyError(text, false), "string")
})

test("invalid policy and duplicate submissions never reach the backend", async () => {
  const sent = [], wait = pending()
  const controller = createPermissionController(unknown(), { send: (reply) => { sent.push(reply); return wait.promise } })
  assert.equal(controller.submit({ scope: "session", policy: "Unknown=S*" }), false)
  assert.equal(sent.length, 0)
  assert.match(controller.getState().error, /no wildcard/)
  assert.equal(controller.submit("always"), false)
  assert.equal(controller.submit("once"), true)
  assert.equal(controller.submit("once"), false)
  assert.equal(sent.length, 1)
  wait.resolve()
  await flush()
  assert.equal(controller.getState().status, "awaiting-event")
})

test("partial policy success stays actionable until the matching reply event", async () => {
  const controller = createPermissionController(policy.withFacts(request(), facts), { send: () => Promise.resolve() })
  assert.equal(controller.submit({ scope: "session", policy: "R=-S" }), true)
  await flush()
  assert.equal(controller.getState().status, "idle")
  controller.resolved("ses_other", "per_test")
  assert.equal(controller.getState().status, "idle")
  controller.resolved("ses_test", "per_test")
  assert.equal(controller.getState().status, "resolved")
  assert.equal(controller.submit("once"), false)
})

test("the session-read shortcut also stays actionable until a reply event", async () => {
  const value = policy.withFacts(request(), { ...facts, operations: ["read"] })
  const controller = createPermissionController(value, { send: () => Promise.resolve() })
  assert.equal(controller.submit("session_read"), true)
  await flush()
  assert.equal(controller.getState().status, "idle")
  controller.resolved(value.sessionID, value.id)
  assert.equal(controller.getState().status, "resolved")
})

test("a resolved or replaced request cannot be reopened by a late transport result", async () => {
  for (const replacement of [false, true]) {
    for (const outcome of ["resolve", "reject"]) {
      const wait = pending(), reported = []
      const controller = createPermissionController(unknown(), { send: () => wait.promise, report: (error) => reported.push(error) })
      controller.submit("once")
      if (replacement) controller.replaceRequest(request({ id: "per_next" }))
      else controller.resolved("ses_test", "per_test")
      wait[outcome](new Error("late"))
      await flush()
      assert.equal(controller.getState().status, replacement ? "idle" : "resolved")
      assert.equal(controller.getState().request.id, replacement ? "per_next" : "per_test")
      assert.equal(controller.getState().error, undefined)
      assert.deepEqual(reported, [])
    }
  }
})

test("backend failure retains its exact error and allows a corrected submission", async () => {
  const failure = new Error("Duplicate filesystem operation R"), reported = []
  const controller = createPermissionController(unknown(), {
    send: () => Promise.reject(failure), report: (error) => reported.push(error),
  })
  controller.submit({ scope: "session", policy: "Unknown=S" })
  await flush()
  assert.equal(controller.getState().status, "idle")
  assert.equal(controller.getState().error, failure.message)
  assert.deepEqual(reported, [failure])
})

test("a renewed prompt needs a fresh explicit decision and ignores the failed attempt's late completion", async () => {
  const first = executableRequest("& 'C:/Progs/node-v24_17/node.exe' --test 'D:/work/test/a.test.mjs'")
  const wait = pending(), sent = []
  const controller = createPermissionController(first, {
    send: (reply) => { sent.push(reply); return sent.length === 1 ? wait.promise : Promise.resolve() },
  })
  assert.equal(controller.submit({ scope: "session", policy: "Unknown=SE" }), true)
  controller.resolved(first.sessionID, first.id)
  const renewed = { ...first, id: "per_reask" }
  controller.replaceRequest(renewed)
  wait.reject(new Error("reply notification failed"))
  await flush()
  assert.equal(controller.getState().request.id, renewed.id)
  assert.equal(controller.getState().status, "idle")
  assert.equal(sent.length, 1, "reasking must never submit approval automatically")
  assert.equal(controller.submit({ scope: "session", policy: "Unknown=SE" }), true)
  assert.equal(sent.length, 2)
  assert.equal(sent[1].requestID, renewed.id)
  controller.dispose()
})

test("disposing a presenter invalidates every pending completion", async () => {
  const wait = pending(), changes = []
  const controller = createPermissionController(unknown(), {
    send: () => wait.promise, changed: (state) => changes.push(state),
  })
  controller.submit("once")
  const before = changes.length
  controller.dispose()
  wait.reject(new Error("disposed"))
  await flush()
  assert.equal(changes.length, before)
  assert.equal(controller.submit("once"), false)
})

test("recursive search presents its exact directory, not its parent", () => {
  const metadata = filesystemMetadata([{ absolute: "/data/project", resource: "." }], ["read"], "content", {
    filesystemReadScope: "recursive",
  })
  const value = request({ action: "grep", resources: ["expression"], metadata })
  assert.deepEqual(policy.readFacts(value).directories, ["/data/project"])
  assert.deepEqual(grants.directories(value), ["/data/project"])
  assert.equal(grants.decision([{
    directory: "/data/project", operation: "read", effect: "allow", lifetime: "session",
    scope: "selected", recursive: false,
  }], value), undefined, "a narrow allow cannot authorize recursive traversal")
})

test("parent-list grants cannot authorize recursive traversal even if marked listing", () => {
  const grant = {
    directory: "/data/project", operation: "read", effect: "allow", lifetime: "session",
    scope: "parent-list", recursive: false,
  }
  const metadata = filesystemMetadata([{ absolute: "/data", resource: "/data" }], ["read"], "listing")
  assert.equal(grants.decision([grant], request({ metadata })), "allow")
  for (const action of ["read", "glob", "grep"]) {
    assert.equal(grants.decision([grant], request({
      action, metadata: { ...metadata, filesystemReadScope: "recursive" },
    })), undefined)
  }
})

test("metadata-only CRUD matching retains deny priority and exact subtree boundaries", () => {
  const rule = (operation, effect) => ({
    directory: "D:/data", operation, effect, lifetime: "session", scope: "selected", recursive: true,
  })
  const classified = (target, operation) => request({
    action: operation === "read" ? "read" : "edit",
    metadata: policy.withFacts({}, { operations: [operation], paths: [target], directories: ["D:/data"] }).metadata,
  })
  assert.equal(grants.decision([rule("update", "allow")], classified("d:\\DATA\\deep\\file", "update")), "allow")
  assert.equal(grants.decision([rule("update", "allow")], classified("D:/data-other/file", "update")), undefined)
  assert.equal(grants.decision([rule("update", "allow"), rule("update", "deny")], classified("D:/data/file", "update")), "deny")
  assert.equal(grants.decision([rule("update", "allow")], classified("D:/data/file", "delete")), undefined)
})

test("malformed stored parent-list or directory grants cannot become entitlements", () => {
  const value = {
    directory: "/data/project", operation: "read", effect: "allow", lifetime: "session",
    scope: "parent-list", recursive: false,
  }
  assert.deepEqual(grants.decode([grants.encode(value)]), [value])
  for (const extra of [
    { recursive: true }, { operation: "update" }, { directory: "relative" }, { directory: "/data/*" },
  ]) assert.throws(() => grants.decode([grants.encode({ ...value, ...extra })]), /Invalid|Parent-list/)
})
