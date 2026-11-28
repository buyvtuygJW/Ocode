import { expect, test } from "bun:test"
import { Deferred, Effect, Exit, Fiber, Layer, Scope, Stream } from "effect"
import { Agent } from "@opencode/core/agent"
import { FileAccess } from "@opencode/core/file-access"
import { SessionMessage } from "@opencode/core/session/message"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SessionProjector } from "@opencode/core/session/projector"
import { Tool } from "@opencode/core/tool"
import { metadataKey, readFacts, withFacts, type Facts } from "@opencode/schema/personalize/permission-policy"
import { SessionEvent } from "@opencode/schema/session-event"
import { EventSequenceTable, EventTable } from "@opencode/core/event/sql"
import { authorizeShellRequests, hasNoFilesystemEffects } from "../../src/personalize/shell-permission"
import { eq } from "drizzle-orm"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

// Exercise the real permission service using the same public graph and fixture
// boundaries as the upstream suite, without editing or importing that suite.
const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionStore.node, SessionProjector.node, PermissionSaved.node, Agent.node, PluginHooks.node, Permission.node]),
    [Location.node.replace(current), Bus.node.replace(Bus.configured({ persist: true }))],
  ),
)

function setup(rules: Permission.Ruleset = [], sessionID = Session.ID.make("ses_test")) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing().run().pipe(Effect.orDie)
    yield* db.insert(SessionTable).values({
      id: sessionID, project_id: Project.ID.global, slug: "test", directory: "/project",
      title: "test", version: "test", agent: Agent.ID.make("test"),
    }).onConflictDoNothing().run().pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: Permission.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* Agent.Service
    yield* agents.transform((editor) =>
      editor.update(Agent.ID.make("test"), (agent) => { agent.permissions = [...rules] }),
    )
  })
}

type Assertion = Partial<Permission.AssertInput> & Partial<Facts>
function assertion(input: Assertion = {}) {
  const value = {
    id: Permission.ID.create(),
    sessionID: Session.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies Permission.AssertInput
  const facts = readFacts(value)
  return facts ? withFacts(value, facts) : value
}

function waitForRequest(input: Assertion = {}) {
  return Effect.gen(function* () {
    const value = assertion(input)
    const service = yield* Permission.Service
    const bus = yield* Bus.Service
    const asked = yield* Deferred.make<Permission.Request>()
    const unsubscribe = yield* bus.listen((event) => {
      if (event.type !== Permission.Event.Asked.type) return Effect.void
      const request = event.data as Permission.Request
      return request.id === value.id ? Deferred.succeed(asked, request).pipe(Effect.asVoid) : Effect.void
    })
    yield* Effect.addFinalizer(() => unsubscribe)
    const fiber = yield* service.assert(value).pipe(Effect.forkScoped)
    const request = yield* Deferred.await(asked)
    return { service, fiber, request }
  })
}

it.effect("location permission graphs do not register session projectors on a shared global Bus", () =>
  Effect.gen(function* () {
    yield* setup()
    const bus = yield* Bus.Service
    const sessions = yield* SessionStore.Service
    const agents = yield* Agent.Service
    const saved = yield* PermissionSaved.Service
    const hooks = yield* PluginHooks.Service
    const globalPermission = yield* Permission.Service
    const registrations: string[] = []
    const observed: Bus.Interface = {
      ...bus,
      project: (definition, projector) => {
        registrations.push(definition.type)
        return bus.project(definition, projector)
      },
    }
    // Like automation's virtual locations, each graph has its own database but
    // borrows the application's Bus and SessionStore. Closing it must not leave
    // a projector on that Bus which still refers to the now-closed database.
    for (let i = 0; i < 2; i++) yield* Effect.scoped(
      Effect.gen(function* () {
        const service = yield* Permission.Service
        expect(service === globalPermission).toBe(false)
        expect(yield* service.list()).toEqual([])
      }).pipe(Effect.provide(AppNodeBuilder.build(Permission.node, [
        Location.node.replace(current),
        Database.node.replace(Database.configured({ path: ":memory:" })),
        Bus.node.replace(Layer.succeed(Bus.Service, observed)),
        SessionStore.node.replace(Layer.succeed(SessionStore.Service, sessions)),
        Agent.node.replace(Layer.succeed(Agent.Service, agents)),
        PermissionSaved.node.replace(Layer.succeed(PermissionSaved.Service, saved)),
        PluginHooks.node.replace(Layer.succeed(PluginHooks.Service, hooks)),
      ]), { local: true })),
    )
    expect(registrations).not.toContain(SessionEvent.Permissions.type)
    // The explicit global projector still persists CRUD grants after both local
    // scopes close; merely removing all projection would not satisfy this test.
    const first = yield* waitForRequest({
      operations: ["read"], paths: ["/project/file"], directories: ["/project"],
    })
    yield* first.service.reply({ requestID: first.request.id, reply: { scope: "session", policy: "R=S*" } })
    yield* Fiber.join(first.fiber)
    expect((yield* sessions.get(first.request.sessionID))?.permissions?.some(
      (rule) => rule.action === "__opencode_filesystem_session_v1",
    )).toBe(true)
  }),
)

it.effect("owned facts survive stock request publication and lookup without extra wire fields", () =>
  Effect.gen(function* () {
    yield* setup()
    const first = yield* waitForRequest({
      operations: ["read"], paths: ["/project/file"], directories: ["/project"], access: "content",
    })
    for (const value of [first.request, yield* first.service.get(first.request.id)]) {
      expect(value).toBeDefined()
      expect(readFacts(value!)).toEqual({
        operations: ["read"], paths: ["/project/file"], directories: ["/project"], access: "content",
      })
      expect("operations" in value!).toBe(false)
      expect("paths" in value!).toBe(false)
      expect("directories" in value!).toBe(false)
    }
    yield* first.service.reply({ requestID: first.request.id, reply: "once" })
    yield* Fiber.join(first.fiber)
  }),
)

for (const boundary of ["event", "get", "list", "forSession"] as const) {
  it.effect(`${boundary} exposes a snapshot, not the pending authorization state`, () =>
    Effect.gen(function* () {
      yield* setup()
      const facts = {
        operations: ["read"] as const, paths: ["/project/file"], directories: ["/project"], access: "content" as const,
      }
      const first = yield* waitForRequest({
        ...facts, source: { type: "tool", messageID: "msg_snapshot", id: "call_snapshot" },
      })
      const exposed = boundary === "event" ? first.request
        : boundary === "get" ? yield* first.service.get(first.request.id)
        : boundary === "list" ? (yield* first.service.list())[0]
        : (yield* first.service.forSession(first.request.sessionID))[0]
      expect(exposed).toBeDefined()
      // Bun's object matcher was observed replacing resources with a matcher
      // object. Reproduce that mutation explicitly, including nested CRUD data.
      Reflect.set(exposed!, "resources", { asymmetricMatch: () => true })
      Reflect.set(exposed!.source!, "id", "call_changed")
      const exposedFacts = exposed!.metadata![metadataKey] as Facts
      Reflect.set(exposedFacts.paths, "0", "/elsewhere/file")
      Reflect.set(exposedFacts.directories!, "0", "/elsewhere")
      const retained = yield* first.service.get(first.request.id)
      expect(retained?.resources).toEqual(["src/index.ts"])
      expect(retained?.source?.id).toBe("call_snapshot")
      expect(readFacts(retained!)).toEqual(facts)
      yield* first.service.reply({ requestID: first.request.id, reply: { scope: "session", policy: "R=S*" } })
      yield* Fiber.join(first.fiber)
      expect((yield* first.service.ask(assertion(facts))).effect).toBe("allow")
      const other = yield* first.service.ask(assertion({
        ...facts, paths: ["/elsewhere/file"], directories: ["/elsewhere"],
      }))
      expect(other.effect).toBe("ask")
      yield* first.service.reply({ requestID: other.id, reply: "reject" })
    }),
  )
}

it.effect("Asked listener mutations cannot alter registration or the later configured-deny recheck", () =>
  Effect.gen(function* () {
    yield* setup()
    const service = yield* Permission.Service
    const bus = yield* Bus.Service
    const unsubscribe = yield* bus.listen((event) => Effect.sync(() => {
      if (event.type !== Permission.Event.Asked.type) return
      const request = event.data as Permission.Request
      Reflect.set(request, "resources", ["allowed-by-listener"])
    }))
    yield* Effect.addFinalizer(() => unsubscribe)
    const pending = yield* waitForRequest()
    expect((yield* service.get(pending.request.id))?.resources).toEqual(["src/index.ts"])
    yield* setRules([{ action: "read", resource: "src/index.ts", effect: "deny" }])
    yield* service.reply({ requestID: pending.request.id, reply: "once" })
    expect(Exit.isFailure(yield* Fiber.await(pending.fiber))).toBe(true)
    expect(yield* service.get(pending.request.id)).toBeUndefined()
    expect((yield* service.ask(assertion())).effect).toBe("deny")
  }),
)

it.effect("shell CRUD policy persists without approving the pending PowerShell program", () =>
  Effect.gen(function* () {
    yield* setup()
    const command = "[IO.File]::ReadAllBytes($p)"
    const first = yield* waitForRequest({
      action: "shell", resources: [command], metadata: {
        filesystemEffects: "unknown", unknownCommand: command,
        unknownCwd: "/project", unknownShell: "powershell.exe",
      },
    })
    yield* first.service.reply({
      requestID: first.request.id, reply: { scope: "session", policy: "RU=S* CD=D*" },
    })
    expect((yield* first.service.list()).some((request) => request.id === first.request.id)).toBe(true)
    const sessions = yield* SessionStore.Service
    const rules = (yield* sessions.get(first.request.sessionID))!.permissions!
    expect(rules.filter((rule) => rule.action === "__opencode_filesystem_session_v1")).toHaveLength(4)
    expect(rules.some((rule) => rule.action === "__opencode_shell_unknown_v1")).toBe(false)
    expect((yield* first.service.ask(assertion({
      action: "read", operations: ["read"], paths: ["/project/file"], directories: ["/project"],
    }))).effect).toBe("allow")
    expect((yield* first.service.ask(assertion({
      action: "edit", operations: ["create"], paths: ["/project/new"], directories: ["/project"],
    }))).effect).toBe("deny")
    yield* first.service.reply({ requestID: first.request.id, reply: { scope: "session", policy: "Unknown=1" } })
    yield* Fiber.join(first.fiber)
  }),
)

it.effect("CRUD settlements retain machine identity and never overwrite another environment's grant", () =>
  Effect.gen(function* () {
    yield* setup()
    const facts = { operations: ["read"] as const, paths: ["/work/file"], directories: ["/work"], access: "content" as const }
    const local = yield* waitForRequest(facts)
    yield* local.service.reply({ requestID: local.request.id, reply: { scope: "session", policy: "R=S*" } })
    yield* Fiber.join(local.fiber)
    const remote = yield* waitForRequest({ ...facts, machine: "gpu", resources: ["gpu:/work/file"] })
    expect(readFacts(remote.request)?.machine).toBe("gpu")
    yield* remote.service.reply({ requestID: remote.request.id, reply: { scope: "session", policy: "R=D*" } })
    expect(Exit.isFailure(yield* Fiber.await(remote.fiber))).toBe(true)
    expect((yield* local.service.ask(assertion(facts))).effect).toBe("allow")
    expect((yield* local.service.ask(assertion({ ...facts, machine: "gpu" }))).effect).toBe("deny")
    expect((yield* local.service.ask(assertion({ ...facts, machine: "other" }))).effect).toBe("ask")
    const store = yield* SessionStore.Service
    const rules = (yield* store.get(local.request.sessionID))!.permissions!
    expect(rules.filter((rule) => rule.action === "__opencode_filesystem_session_v1")).toHaveLength(2)
  }),
)

for (const policy of ["Unknown=S", "Unknown=SE", "Unknown=SEA", "Whole=SEA"]) {
  it.effect(`${policy} settlements cannot approve the same executable on another machine`, () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "allow" }])
      const input = { action: "shell", resources: ["runner"], metadata: {
        filesystemEffects: "unknown", unknownCommand: "& 'C:/Tools/runner.exe' test/a.ts",
        unknownCwd: "C:/work", unknownShell: "powershell.exe", unknownMachine: "gpu",
      } }
      const first = yield* waitForRequest(input)
      yield* first.service.reply({ requestID: first.request.id, reply: { scope: "session", policy } })
      yield* Fiber.join(first.fiber)
      expect((yield* first.service.ask(assertion(input))).effect).toBe("allow")
      for (const unknownMachine of [undefined, "other"]) expect((yield* first.service.ask(assertion({
        ...input, metadata: { ...input.metadata, unknownMachine },
      }))).effect).toBe("ask")
    }),
  )
}

it.effect("structured denial is selective while ordinary rejection still rejects the message batch", () =>
  Effect.gen(function* () {
    yield* setup()
    const source = { type: "tool" as const, messageID: "msg_batch", id: "call_batch" }
    const selected = yield* waitForRequest({
      id: Permission.ID.create(), source, operations: ["read"], paths: ["/selected/file"], directories: ["/selected"],
    })
    const unrelated = yield* waitForRequest({
      id: Permission.ID.create(), source, operations: ["read"], paths: ["/other/file"], directories: ["/other"],
    })
    const sibling = yield* waitForRequest({
      id: Permission.ID.create(), source, operations: ["read"], paths: ["/other/second"], directories: ["/other"],
    })
    yield* selected.service.reply({ requestID: selected.request.id, reply: { scope: "session", policy: "R=D*" } })
    expect(Exit.isFailure(yield* Fiber.await(selected.fiber))).toBe(true)
    expect((yield* selected.service.list()).map((request) => request.id).sort())
      .toEqual([unrelated.request.id, sibling.request.id].sort())
    yield* selected.service.reply({ requestID: unrelated.request.id, reply: "reject" })
    expect(Exit.isFailure(yield* Fiber.await(unrelated.fiber))).toBe(true)
    expect(Exit.isFailure(yield* Fiber.await(sibling.fiber))).toBe(true)
    expect(yield* selected.service.list()).toEqual([])
  }),
)

it.effect("Unknown=S cannot override a configured deny installed while the prompt was pending", () =>
  Effect.gen(function* () {
    yield* setup([{ action: "*", resource: "*", effect: "allow" }])
    const first = yield* waitForRequest({
      action: "shell", resources: ["npm run dev"],
      metadata: {
        filesystemEffects: "unknown", unknownCommand: "npm run dev",
        unknownCwd: "/project", unknownShell: "powershell.exe",
      },
    })
    yield* setRules([{ action: "shell", resource: "*", effect: "deny" }])
    yield* first.service.reply({ requestID: first.request.id, reply: { scope: "session", policy: "Unknown=S" } })
    expect(Exit.isFailure(yield* Fiber.await(first.fiber))).toBe(true)
    const sessions = yield* SessionStore.Service
    const current = yield* sessions.get(first.request.sessionID)
    expect(current?.permissions?.some((rule) => rule.action === "__opencode_shell_unknown_v1") ?? false).toBe(false)
  }),
)

it.effect("Unknown=SEA allows new arguments for one literal executable, not compound scripts or another scope", () =>
  Effect.gen(function* () {
    yield* setup([{ action: "*", resource: "*", effect: "allow" }])
    const metadata = {
      filesystemEffects: "unknown",
      unknownCommand: "& 'Z:/PortableGit/cmd/git.exe' status",
      unknownCwd: "/project",
      unknownShell: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    }
    const first = yield* waitForRequest({ action: "shell", resources: [metadata.unknownCommand], metadata })
    yield* first.service.reply({ requestID: first.request.id, reply: { scope: "session", policy: "Unknown=SEA" } })
    yield* Fiber.join(first.fiber)
    const request = (command: string, change: Partial<typeof metadata> = {}) => assertion({
      id: Permission.ID.create(), action: "shell", resources: [command],
      metadata: { ...metadata, unknownCommand: command, ...change },
    })
    expect((yield* first.service.ask(request("& 'Z:/PortableGit/cmd/git.exe' diff --stat"))).effect).toBe("allow")
    for (const input of [
      request("& 'D:/other/git.exe' status"),
      request("& 'Z:/PortableGit/cmd/git.exe' status; Write-Output done"),
      request("$git = 'Z:/PortableGit/cmd/git.exe'; & $git status"),
      request("& 'Z:/PortableGit/cmd/git.exe' status", { unknownCwd: "/elsewhere" }),
    ]) {
      const pending = yield* first.service.ask(input)
      expect(pending.effect).toBe("ask")
      yield* first.service.reply({ requestID: pending.id, reply: "reject" })
    }
    yield* setRules([{ action: "shell", resource: "*", effect: "deny" }])
    expect((yield* first.service.ask(request("& 'Z:/PortableGit/cmd/git.exe' log"))).effect).toBe("deny")
  }),
)

it.effect("Whole=SEA remembers the entire bulk move loop, never a standalone command inside it", () =>
  Effect.gen(function* () {
    yield* setup()
    const script = "$r='D:/work'; foreach($d in @(Get-ChildItem -LiteralPath $r)) { Move-Item -LiteralPath $d.FullName -Destination 'archived' }"
    const shell = (command: string, cwd = "D:/work") => ({
      action: "shell", resources: [command], metadata: {
        filesystemEffects: "unknown", unknownCommand: command, unknownCwd: cwd, unknownShell: "powershell.exe",
      },
    })
    const first = yield* waitForRequest(shell(script))
    yield* first.service.reply({ requestID: first.request.id, reply: { scope: "session", policy: "Whole=SEA" } })
    yield* Fiber.join(first.fiber)
    const ask = (command: string, cwd?: string) => first.service.ask(assertion(shell(command, cwd)))
    expect((yield* ask(script.replace("'archived'", "'other'"))).effect).toBe("allow")
    for (const changed of ["Move-Item first second", script.replace("Move-Item", "Copy-Item"), script + "; Get-Date"])
      expect((yield* ask(changed)).effect).toBe("ask")
    expect((yield* ask(script, "D:/elsewhere")).effect).toBe("ask")
    yield* setRules([{ action: "shell", resource: "Move-Item *", effect: "deny" }])
    expect((yield* ask(script)).effect).toBe("deny")
  }),
)

it.effect("a Git SEA grant covers a Git-only && chain and respects a deny on a later command", () =>
  Effect.gen(function* () {
    yield* setup()
    const shell = (command: string) => ({
      action: "shell", resources: [command], metadata: {
        filesystemEffects: "unknown", unknownCommand: command, unknownCwd: "D:/work", unknownShell: "pwsh.exe",
      },
    })
    const first = yield* waitForRequest(shell("git add ."))
    yield* first.service.reply({ requestID: first.request.id, reply: { scope: "session", policy: "Unknown=SEA" } })
    yield* Fiber.join(first.fiber)
    const chain = "git add . && git commit -m xxx && git status"
    const ask = (command: string) => first.service.ask(assertion(shell(command)))
    expect((yield* ask(chain)).effect).toBe("allow")
    expect(yield* first.service.list()).toEqual([])
    expect((yield* ask("git add . && node --version")).effect).toBe("ask")
    yield* setRules([{ action: "shell", resource: "git commit *", effect: "deny" }])
    expect((yield* ask(chain)).effect).toBe("deny")
  }),
)

it.effect("ZIP SEA reuse checks the new archive against CRUD before shell execution", () =>
  Effect.gen(function* () {
    yield* setup()
    const permission = yield* Permission.Service
    const context = {
      id: Tool.CallID.make("call_zip"), sessionID: Session.ID.make("ses_test"),
      messageID: SessionMessage.ID.make("msg_zip"), agent: Agent.ID.make("test"),
    }
    yield* Effect.gen(function* () {
      const access = yield* FileAccess.Service
      const target = yield* access.resolve({ path: ".", kind: "directory" })
      const file = (name: string) => access.resolve({ path: name, kind: "file", base: target })
      const allowed = yield* file("allowed/a.zip")
      const other = yield* file("allowed/b.zip")
      const privateZip = yield* file("private/a.zip")
      for (const [archive, policy] of [[allowed, "R=S*"], [privateZip, "R=D*"]] as const) {
        const directory = (yield* file(archive === allowed ? "allowed" : "private")).absolute
        const first = yield* waitForRequest({ action: "read", resources: [archive.resource],
          operations: ["read"], paths: [archive.absolute], directories: [directory], access: "content" })
        yield* first.service.reply({ requestID: first.request.id, reply: { scope: "session", policy } })
        expect(Exit.isSuccess(yield* Fiber.await(first.fiber))).toBe(archive === allowed)
      }
      const execute = (archive: string, entry: string) => {
        const command = `Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [IO.Compression.ZipFile]::OpenRead('${archive}')
try {
  $e = $z.GetEntry('${entry}')
  $s = $e.Open()
  $r = [IO.StreamReader]::new($s)
  try { $r.ReadToEnd() | ConvertFrom-Json } finally { $r.Dispose() }
} finally { $z.Dispose() }`
        return authorizeShellRequests({ access, permission, context, target, requests: [{ action: "shell", resources: [command] }],
          invocation: { command, cwd: target.absolute, shell: "pwsh", env: {}, timeout: 30000 } })
      }
      const bus = yield* Bus.Service
      const asked = yield* Deferred.make<Permission.Request>()
      const prompts: string[] = []
      const unsubscribe = yield* bus.listen((event) => {
        if (event.type !== Permission.Event.Asked.type) return Effect.void
        const request = event.data as Permission.Request
        prompts.push(request.action)
        return Deferred.succeed(asked, request).pipe(Effect.asVoid)
      })
      yield* Effect.addFinalizer(() => unsubscribe)
      const initial = yield* execute(allowed.absolute, "one.json").pipe(Effect.forkScoped)
      const shell = yield* Deferred.await(asked)
      expect(shell.action).toBe("shell")
      yield* permission.reply({ requestID: shell.id, reply: { scope: "session", policy: "Unknown=SEA" } })
      yield* Fiber.join(initial)
      yield* execute(other.absolute, "nested/two.json")
      const rejected = yield* execute(privateZip.absolute, "one.json").pipe(Effect.flip)
      expect(rejected).toMatchObject({ _tag: "Permission.BlockedError", permission: "read", resources: [privateZip.resource] })
      const outside = yield* file("../outside.zip")
      yield* setRules([{ action: "external_directory", resource: "*", effect: "deny" }])
      expect(yield* execute(outside.absolute, "one.json").pipe(Effect.flip)).toMatchObject({
        _tag: "Permission.BlockedError", permission: "external_directory",
      })
      expect(prompts).toEqual(["shell"])
    }).pipe(Effect.provide(AppNodeBuilder.build(FileAccess.node, [
      Location.node.replace(current), Permission.node.replace(Layer.succeed(Permission.Service, permission)),
    ]), { local: true }))
  }),
)

it.effect("Unknown=SE reuses Node test files only in the same parent directory with the same argument structure", () =>
  Effect.gen(function* () {
    yield* setup()
    const metadata = {
      filesystemEffects: "unknown",
      unknownCommand: "& 'C:/Progs/node-v24_17/node.exe' --test 'D:/Prog/own/mixed/publicgitrepo/ocode/deltav12/personalize-src/base/packages/core/test/permission/service.node.test.mjs'",
      unknownCwd: "D:/Prog/own/mixed/publicgitrepo/ocode/deltav12",
      unknownShell: "C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    }
    const first = yield* waitForRequest({ action: "shell", resources: [metadata.unknownCommand], metadata })
    yield* first.service.reply({ requestID: first.request.id, reply: { scope: "session", policy: "Unknown=SE" } })
    yield* Fiber.join(first.fiber)
    const command = "& 'C:/Progs/node-v24_17/node.exe' --test 'D:/Prog/own/mixed/publicgitrepo/ocode/deltav12/personalize-src/base/packages/core/test/permission/session-grant.test.mjs'"
    const result = yield* first.service.ask(assertion({
      action: "shell", resources: [command], metadata: { ...metadata, unknownCommand: command },
    }))
    expect(result.effect).toBe("allow")
    expect(yield* first.service.list()).toEqual([])
    const multiple = command + " 'D:/Prog/own/mixed/publicgitrepo/ocode/deltav12/personalize-src/base/packages/core/test/permission/another.test.mjs'"
    expect((yield* first.service.ask(assertion({
      action: "shell", resources: [multiple], metadata: { ...metadata, unknownCommand: multiple },
    }))).effect).toBe("allow")
    for (const next of [
      command.replace("/test/permission/", "/src/permission/"),
      command.replace(" --test ", " build "),
      command.replace(" --test ", " --test --watch "),
    ]) {
      const result = yield* first.service.ask(assertion({
        action: "shell", resources: [next], metadata: { ...metadata, unknownCommand: next },
      }))
      expect(result.effect).toBe("ask")
      yield* first.service.reply({ requestID: result.id, reply: "reject" })
    }
  }),
)

for (const command of [
  "git status --short",
  'node "$base\\synthetic-transform-profile.mjs" "$base\\diagnostics-gate-detail-01" batch',
]) {
  it.effect(`Unknown=SEA settles and remembers the real named-command request: ${command}`, () =>
    Effect.gen(function* () {
      yield* setup()
      const metadata = {
        filesystemEffects: "unknown", unknownCommand: command,
        unknownCwd: "D:/work", unknownShell: "powershell.exe", unknownLookup: "environment-one",
      }
      const first = yield* waitForRequest({ action: "shell", resources: [command], metadata })
      yield* first.service.reply({ requestID: first.request.id, reply: { scope: "session", policy: "Unknown=SEA" } })
      yield* Fiber.join(first.fiber)
      const next = command.startsWith("git") ? "git add file.txt" : 'node "$other\\next.mjs" different'
      const input = (text: string, change = {}) => assertion({
        action: "shell", resources: [text], metadata: { ...metadata, unknownCommand: text, ...change },
      })
      expect((yield* first.service.ask(input(next))).effect).toBe("allow")
      for (const candidate of [
        input(next + "; whoami"), input(next + " | Out-String"), input('node "$(whoami)"'),
        input(next, { unknownCwd: "D:/other" }), input(next, { unknownLookup: "environment-two" }),
        input(next, { unknownMachine: "remote" }), input("different-command --version"),
      ]) {
        const pending = yield* first.service.ask(candidate)
        expect(pending.effect).toBe("ask")
        yield* first.service.reply({ requestID: pending.id, reply: "reject" })
      }
      yield* setRules([{ action: "shell", resource: "*", effect: "deny" }])
      expect((yield* first.service.ask(input(next))).effect).toBe("deny")
    }),
  )
}

it.effect("concurrent listing requests consume R=-1 at most once", () =>
  Effect.gen(function* () {
    yield* setup()
    const first = yield* waitForRequest({
      operations: ["read"], paths: ["/parent/selected/file"], directories: ["/parent/selected"], access: "content",
    })
    yield* first.service.reply({ requestID: first.request.id, reply: { scope: "session", policy: "R=-1" } })
    const requests = [0, 1].map(() => assertion({
      id: Permission.ID.create(), operations: ["read"], paths: ["/parent"], directories: ["/parent"], access: "listing",
    }))
    const results = yield* Effect.all(requests.map((input) => first.service.ask(input)), { concurrency: "unbounded" })
    expect(results.filter((result) => result.effect === "allow")).toHaveLength(1)
    expect(results.filter((result) => result.effect === "ask")).toHaveLength(1)
    yield* first.service.close
    expect(Exit.isFailure(yield* Fiber.await(first.fiber))).toBe(true)
  }),
)

test("only simple built-in queries and literal output on system PowerShell are classified as effect-free", () => {
  const system = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
  const check = (command: string, shell = system, platform = "win32", root = "C:\\Windows") =>
    hasNoFilesystemEffects(command, shell, platform, root)
  expect(check("Write-Output 'shell permission test'")).toBe(true)
  expect(check("echo hi")).toBe(true)
  expect(check('Write-Host "hello world"')).toBe(true)
  expect(check("Get-Location")).toBe(true)
  expect(check("pwd")).toBe(true)
  expect(check("Get-Host")).toBe(true)
  expect(check("Get-Culture")).toBe(true)
  expect(check("Get-UICulture")).toBe(true)
  expect(check("Get-Random")).toBe(true)
  expect(check("Get-Date")).toBe(true)
  expect(check("Get-Date -Format yyyy-MM-dd")).toBe(true)
  expect(check('Get-Date -Format "yyyy-MM-dd HH:mm"')).toBe(true)
  for (const command of [
    "Write-Output 'hi'; Remove-Item file",
    "Write-Output 'hi' > file",
    "Write-Output 'hi' | Remove-Item",
    "Write-Output 'hi'\nRemove-Item file",
    'Write-Output "$(Remove-Item file)"',
    "Write-Output $env:PATH",
    "Get-Date; Remove-Item file",
    "Get-Date > file",
    "Get-Date | Remove-Item",
    "Get-Date\nRemove-Item file",
    'Get-Date -Format "$(Remove-Item file)"',
    "Get-Date -Date (Get-Content file)",
    "echo holyshxt>>DAMNVIRUS",
    "echo hi > file",
    "echo hi | Remove-Item",
    "echo hi; Remove-Item file",
    "echo $(Remove-Item file)",
    'echo "$($env:malicious)"',
    "Get-Location | Remove-Item",
    "Get-Process",
    "npm run dev",
    "Remove-Item file",
  ]) expect(check(command)).toBe(false)
  expect(check("Write-Output 'hi'", "C:\\temp\\powershell.exe")).toBe(false)
  expect(check("Write-Output 'hi'", system, "linux")).toBe(false)
  expect(check("Write-Output 'hi'", system, "win32", "relative")).toBe(false)
})

it.effect("unknown shell commands ask by default even without filesystem denies", () =>
  Effect.gen(function* () {
    yield* setup([{ action: "*", resource: "*", effect: "allow" }])
    const unknown = {
      action: "shell",
      resources: ["npm run dev"],
      metadata: {
        filesystemEffects: "unknown", unknownCommand: "npm run dev",
        unknownCwd: "D:/Data/Project", unknownShell: "powershell.exe",
      },
    }
    const first = yield* waitForRequest(unknown)
    expect(first.request.message).toContain("Unknown effects:")
    yield* first.service.reply({ requestID: first.request.id, reply: "once" })
    yield* Fiber.join(first.fiber)
    const redirect = yield* first.service.ask(assertion({
      id: Permission.ID.create("per_unknown_redirect"), action: "shell", resources: ["echo holyshxt>>DAMNVIRUS"],
      metadata: {
        filesystemEffects: "unknown", unknownCommand: "echo holyshxt>>DAMNVIRUS",
        unknownCwd: "D:/Data/Project", unknownShell: "powershell.exe",
      },
    }))
    expect(redirect.effect).toBe("ask")
    yield* first.service.reply({ requestID: redirect.id, reply: "reject" })
    const second = yield* waitForRequest({ ...unknown, id: Permission.ID.create("per_unknown_default_2") })
    yield* second.service.reply({ requestID: second.request.id, reply: { scope: "session", policy: "Unknown=S" } })
    yield* Fiber.join(second.fiber)
    expect((yield* second.service.ask(assertion(unknown))).effect).toBe("allow")
    yield* setRules([
      { action: "*", resource: "*", effect: "allow" },
      { action: "external_directory", resource: "*", effect: "ask" },
    ])
    const directory = yield* waitForRequest({
      id: Permission.ID.create("per_unknown_default_dir"), action: "external_directory",
      operations: ["read"], paths: ["D:/Data/Project"], resources: ["D:/Data/Project/*"],
      directories: ["D:/Data/Project"],
    })
    yield* directory.service.reply({ requestID: directory.request.id, reply: { scope: "session", policy: "R=S* D=D" } })
    yield* Fiber.join(directory.fiber)
    expect((yield* directory.service.ask(assertion(unknown))).effect).toBe("ask")
  }),
)

it.effect("unknown shell approvals are explicit, command-scoped, durable and never wildcarded", () =>
  Effect.gen(function* () {
    yield* setup()
    const initial = yield* waitForRequest({
      action: "external_directory", operations: ["read"], paths: ["D:/Data/Project"],
      resources: ["D:/Data/Project/*"], directories: ["D:/Data/Project"],
    })
    yield* initial.service.reply({ requestID: initial.request.id, reply: { scope: "session", policy: "R=S* D=D" } })
    yield* Fiber.join(initial.fiber)
    const unknown = {
      action: "shell",
      resources: ["npm run dev"],
      metadata: {
        filesystemEffects: "unknown", unknownCommand: "npm run dev",
        unknownCwd: "D:/Data/Project", unknownShell: "powershell.exe",
      },
    }
    const first = yield* waitForRequest(unknown)
    const invalid = yield* first.service.reply({
      requestID: first.request.id, reply: { scope: "session", policy: "Unknown=S*" },
    }).pipe(Effect.flip)
    expect(invalid._tag).toBe("Permission.InvalidPolicyError")
    yield* first.service.reply({ requestID: first.request.id, reply: { scope: "session", policy: "Unknown=1" } })
    yield* Fiber.join(first.fiber)
    const second = yield* waitForRequest({ ...unknown, id: Permission.ID.create("per_unknown2") })
    yield* second.service.reply({ requestID: second.request.id, reply: { scope: "session", policy: "Unknown=S" } })
    yield* Fiber.join(second.fiber)
    expect((yield* second.service.ask(assertion(unknown))).effect).toBe("allow")
    expect((yield* second.service.ask(assertion({
      ...unknown, metadata: { ...unknown.metadata, unknownCommand: "npm run build" },
    }))).effect).toBe("ask")
    yield* setRules([{ action: "shell", resource: "*", effect: "deny" }])
    expect((yield* second.service.ask(assertion(unknown))).effect).toBe("deny")
  }),
)

it.effect("session CRUD settles concurrent family reads and denies C/D without project-global persistence or widening", () =>
  Effect.gen(function* () {
    const parent = Session.ID.make("ses_test")
    const child = Session.ID.make("ses_crud_child")
    const unrelated = Session.ID.make("ses_crud_unrelated")
    yield* setup([], parent)
    yield* setup([], child)
    yield* setup([], unrelated)
    const { db } = yield* Database.Service
    yield* db.update(SessionTable).set({ parent_id: parent }).where(eq(SessionTable.id, child)).run().pipe(Effect.orDie)
    const first = yield* waitForRequest({
      action: "external_directory", operations: ["read"],
      paths: ["D:/Data/Project"], resources: ["D:/Data/Project/*"], save: ["D:/Data/*"],
    })
    const second = yield* waitForRequest({
      id: Permission.ID.create(), sessionID: child, action: "read", operations: ["read"],
      paths: ["d:\\data\\project\\deep\\file"], resources: ["d:/data/project/deep/file"],
    })
    const other = yield* waitForRequest({
      id: Permission.ID.create(), sessionID: unrelated, action: "read", operations: ["read"],
      paths: ["D:/Data/Project/file"], resources: ["D:/Data/Project/file"],
    })
    yield* first.service.reply({
      requestID: first.request.id, reply: { scope: "session", policy: "RU=S* CD=D*" },
    })
    yield* Fiber.join(first.fiber)
    yield* Fiber.join(second.fiber)
    expect((yield* first.service.list()).map((request) => request.id)).toEqual([other.request.id])
    for (const operation of ["read", "update", "create", "delete"] as const) {
      const result = yield* first.service.ask(assertion({
        id: Permission.ID.create(), sessionID: child, action: operation === "read" ? "read" : "edit",
        operations: [operation], paths: ["D:/Data/Project/deep/file"],
        resources: ["D:/Data/Project/deep/file"],
      }))
      expect(result.effect).toBe(operation === "read" || operation === "update" ? "allow" : "deny")
    }
    expect(yield* first.service.allows(assertion({
      operations: ["read"], paths: ["D:/Data/Project-other/file"], resources: ["D:/Data/Project-other/file"],
    }))).toBe(false)
    expect(yield* first.service.allows(assertion({
      action: "shell", operations: ["read"], paths: ["D:/Data/Project/file"], resources: ["cat file"],
    }))).toBe(false)
    const saved = yield* PermissionSaved.Service
    expect(yield* saved.list({ projectID: Project.ID.global })).toEqual([])
    yield* first.service.reply({ requestID: other.request.id, reply: "once" })
    yield* Fiber.join(other.fiber)
  }),
)

it.effect("session read approvals never override later explicit agent denies", () =>
  Effect.gen(function* () {
    yield* setup([])
    const first = yield* waitForRequest({
      action: "external_directory", operations: ["read"],
      paths: ["D:/Data/Project"], resources: ["D:/Data/Project/*"],
    })
    yield* first.service.reply({ requestID: first.request.id, reply: "session_read" })
    yield* Fiber.join(first.fiber)
    yield* setRules([{ action: "read", resource: "*", effect: "deny" }])
    expect(yield* first.service.ask(assertion({
      operations: ["read"], paths: ["D:/Data/Project/file"], resources: ["D:/Data/Project/file"],
    }))).toMatchObject({ effect: "deny" })
  }),
)

for (const policy of ["Unknown=S", "Unknown=SE", "Unknown=SEA", "Whole=SEA"] as const) {
  it.effect(`${policy}: failed real Replied publication retains the unapproved prompt for explicit retry`, () =>
    Effect.gen(function* () {
      yield* setup()
      const command = "& 'C:/Progs/node-v24_17/node.exe' --test 'D:/project/test/a.test.mjs'"
      const unknown = {
        action: "shell", resources: [command],
        metadata: { filesystemEffects: "unknown", unknownCommand: command, unknownCwd: "D:/project", unknownShell: "powershell.exe" },
      }
      const first = yield* waitForRequest(unknown)
      const bus = yield* Bus.Service
      const unsubscribe = yield* bus.listen((event) =>
        event.type === Permission.Event.Replied.type && (event.data as { requestID: Permission.ID }).requestID === first.request.id
          ? Effect.die(new Error("injected reply failure")) : Effect.void)
      const exit = yield* Effect.exit(first.service.reply({
        requestID: first.request.id, reply: { scope: "session", policy },
      }))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(first.fiber.pollUnsafe()).toBeUndefined()
      expect(yield* first.service.get(first.request.id)).toBeUndefined()
      const renewed = yield* first.service.list()
      expect(renewed).toHaveLength(1)
      expect(renewed[0].id).not.toBe(first.request.id)
      expect(Exit.isFailure(yield* Effect.exit(first.service.reply({ requestID: first.request.id, reply: "once" })))).toBe(true)
      const { db } = yield* Database.Service
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, first.request.sessionID)).get().pipe(Effect.orDie)
      expect(row?.permission ?? []).toEqual([])
      yield* unsubscribe
      const another = yield* first.service.ask(assertion({ ...unknown, id: Permission.ID.create() }))
      expect(another.effect).toBe("ask")
      yield* first.service.reply({ requestID: another.id, reply: "once" })
      yield* first.service.reply({ requestID: renewed[0].id, reply: { scope: "session", policy } })
      yield* Fiber.join(first.fiber)
    }),
  )
}

it.effect("Allow once publication failure reasks with a fresh ID; cancellation removes the renewal", () =>
  Effect.gen(function* () {
    yield* setup()
    const first = yield* waitForRequest({ operations: ["read"], paths: ["D:/project/a"], resources: ["D:/project/a"] })
    const bus = yield* Bus.Service
    const unsubscribe = yield* bus.listen((event) =>
      event.type === Permission.Event.Replied.type && (event.data as { requestID: Permission.ID }).requestID === first.request.id
        ? Effect.die(new Error("injected once notification failure")) : Effect.void)
    expect(Exit.isFailure(yield* Effect.exit(first.service.reply({ requestID: first.request.id, reply: "once" })))).toBe(true)
    yield* unsubscribe
    const renewed = yield* first.service.list()
    expect(renewed).toHaveLength(1)
    expect(renewed[0].id).not.toBe(first.request.id)
    expect(first.fiber.pollUnsafe()).toBeUndefined()
    yield* Fiber.interrupt(first.fiber)
    expect(yield* first.service.get(renewed[0].id)).toBeUndefined()
    expect(Exit.isFailure(yield* Effect.exit(first.service.reply({ requestID: renewed[0].id, reply: "once" })))).toBe(true)
  }),
)

it.effect("unknown Allow once cannot override a newly configured deny", () =>
  Effect.gen(function* () {
    yield* setup()
    const first = yield* waitForRequest({
      action: "shell", resources: ["npm run test"],
      metadata: { filesystemEffects: "unknown", unknownCommand: "npm run test", unknownCwd: "D:/project", unknownShell: "powershell.exe" },
    })
    yield* setRules([{ action: "shell", resource: "*", effect: "deny" }])
    yield* first.service.reply({ requestID: first.request.id, reply: "once" })
    expect(Exit.isFailure(yield* Fiber.await(first.fiber))).toBe(true)
  }),
)

it.effect("failed second real batch notification restores both CRUD prompts without a grant", () =>
  Effect.gen(function* () {
    yield* setup()
    const first = yield* waitForRequest({
      action: "external_directory", operations: ["read"], paths: ["D:/project"],
      directories: ["D:/project"], resources: ["D:/project/*"],
    })
    const second = yield* waitForRequest({
      id: Permission.ID.create(), operations: ["read"], paths: ["D:/project/a"],
      resources: ["D:/project/a"],
    })
    const bus = yield* Bus.Service
    let notices = 0
    const unsubscribe = yield* bus.listen((event) => {
      if (event.type === Permission.Event.Replied.type && ++notices === 2)
        return Effect.die(new Error("second notification failed"))
      return Effect.void
    })
    const reply = yield* Effect.exit(first.service.reply({
      requestID: first.request.id, reply: { scope: "session", policy: "R=S*" },
    }))
    expect(Exit.isFailure(reply)).toBe(true)
    expect(first.fiber.pollUnsafe()).toBeUndefined()
    expect(second.fiber.pollUnsafe()).toBeUndefined()
    const renewed = yield* first.service.list()
    expect(renewed).toHaveLength(2)
    expect(renewed.every((item) => item.id !== first.request.id && item.id !== second.request.id)).toBe(true)
    const { db } = yield* Database.Service
    const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, first.request.sessionID)).get().pipe(Effect.orDie)
    expect(row?.permission ?? []).toEqual([])
    yield* unsubscribe
    const renewedFirst = renewed.find((item) => item.action === "external_directory")!
    yield* first.service.reply({ requestID: renewedFirst.id, reply: { scope: "session", policy: "R=S*" } })
    yield* Fiber.join(first.fiber)
    yield* Fiber.join(second.fiber)
  }),
)

it.effect("real permissions projector failure rolls back and reasks rather than releasing", () =>
  Effect.gen(function* () {
    yield* setup()
    const first = yield* waitForRequest({
      action: "external_directory", operations: ["read"], paths: ["D:/project"],
      directories: ["D:/project"], resources: ["D:/project/*"],
    })
    const bus = yield* Bus.Service
    let fail = true
    yield* bus.project(SessionEvent.Permissions, () => Effect.suspend(() => {
      if (!fail) return Effect.void
      fail = false
      return Effect.die(new Error("injected projector failure"))
    }))
    const exit = yield* Effect.exit(first.service.reply({
      requestID: first.request.id, reply: { scope: "session", policy: "R=S*" },
    }))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(first.fiber.pollUnsafe()).toBeUndefined()
    const renewed = yield* first.service.list()
    expect(renewed).toHaveLength(1)
    expect(renewed[0].id).not.toBe(first.request.id)
    const { db } = yield* Database.Service
    const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, first.request.sessionID)).get().pipe(Effect.orDie)
    expect(row?.permission ?? []).toEqual([])
    yield* first.service.reply({ requestID: renewed[0].id, reply: { scope: "session", policy: "R=S*" } })
    yield* Fiber.join(first.fiber)
  }),
)

for (const policy of ["R=S*", "R=-S"]) {
it.effect(`${policy}: cancelling the waiter during projection prevents authorization and orphan prompts`, () =>
  Effect.gen(function* () {
    yield* setup()
    const first = yield* waitForRequest({
      action: "external_directory", operations: ["read"], paths: ["D:/project"],
      directories: ["D:/project"], resources: ["D:/project/*"],
    })
    // Wait behind the post-Asked registration check before interrupting its
    // waiter from a projector. Otherwise stock create() is still uninterruptible.
    yield* Effect.yieldNow
    yield* first.service.allows(assertion())
    const bus = yield* Bus.Service
    yield* bus.project(SessionEvent.Permissions, () => Fiber.interrupt(first.fiber).pipe(Effect.asVoid))
    const exit = yield* Effect.exit(first.service.reply({
      requestID: first.request.id, reply: { scope: "session", policy },
    }))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Exit.isFailure(yield* Fiber.await(first.fiber))).toBe(true)
    expect(yield* first.service.list()).toEqual([])
    const { db } = yield* Database.Service
    const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, first.request.sessionID)).get().pipe(Effect.orDie)
    expect(row?.permission ?? []).toEqual([])
  }),
)
}

it.effect("checked typed failures preserve rollback, release the receipt, and never reach committed streams", () =>
  Effect.gen(function* () {
    yield* setup()
    const bus = yield* Bus.Service
    const { db } = yield* Database.Service
    const sessionID = Session.ID.make("ses_test")
    const data = { sessionID, permissions: [{ action: "read", resource: "*", effect: "allow" as const }] }
    const checkError = { _tag: "CheckedCheckRejected" as const }
    const commitError = { _tag: "CheckedCommitRejected" as const }
    const live = yield* bus.subscribe().pipe(
      Stream.filter((event) => event.type === SessionEvent.Permissions.type),
      Stream.take(1), Stream.runCollect, Effect.forkScoped,
    )
    const typed = yield* bus.subscribe(SessionEvent.Permissions).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    let commits = 0
    for (const phase of ["check", "commit"] as const) {
      const failure = yield* bus.publishChecked(SessionEvent.Permissions, data, {
        check: phase === "check" ? Effect.fail(checkError) : Effect.void,
        commit: () => Effect.gen(function* () {
          commits++
          // This write and the stock permissions projector must both roll back.
          yield* db.update(SessionTable).set({ title: "must roll back" })
            .where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
          return yield* Effect.fail(commitError)
        }),
      }).pipe(Effect.flip)
      expect(failure).toBe(phase === "check" ? checkError : commitError)
      expect(commits).toBe(phase === "check" ? 0 : 1)
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
      expect(row?.permission ?? []).toEqual([])
      expect(row?.title).toBe("test")
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* db.select().from(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, sessionID)).all().pipe(Effect.orDie)).toEqual([])
      expect(live.pollUnsafe()).toBeUndefined()
      expect(typed.pollUnsafe()).toBeUndefined()
    }
    const committed = yield* bus.publishChecked(SessionEvent.Permissions, data, { check: Effect.void })
    expect(Number(committed.durable.seq)).toBe(0)
    expect((yield* Fiber.join(live)).map((event) => event.id)).toEqual([committed.id])
    expect((yield* Fiber.join(typed)).map((event) => event.id)).toEqual([committed.id])
    const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie)
    expect(row?.permission).toEqual(data.permissions)
  }),
)

it.effect("checked transaction interruption rolls back and completes the failed receipt", () =>
  Effect.gen(function* () {
    yield* setup()
    const first = yield* waitForRequest({
      action: "external_directory", operations: ["read"], paths: ["D:/project"],
      directories: ["D:/project"], resources: ["D:/project/*"],
    })
    const bus = yield* Bus.Service
    let fail = true
    yield* bus.project(SessionEvent.Permissions, () => Effect.suspend(() => {
      if (!fail) return Effect.void
      fail = false
      return Effect.interrupt
    }))
    const attempt = yield* first.service.reply({
      requestID: first.request.id, reply: { scope: "session", policy: "R=S*" },
    }).pipe(Effect.forkScoped)
    expect(Exit.isFailure(yield* Fiber.await(attempt))).toBe(true)
    expect(first.fiber.pollUnsafe()).toBeUndefined()
    const { db } = yield* Database.Service
    const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, first.request.sessionID)).get().pipe(Effect.orDie)
    expect(row?.permission ?? []).toEqual([])
    const history = yield* bus.log({ aggregateID: first.request.sessionID, follow: false }).pipe(Stream.runCollect)
    expect(history.filter((event) => event.type === SessionEvent.Permissions.type)).toEqual([])
    const renewed = yield* first.service.list()
    expect(renewed).toHaveLength(1)
    expect(renewed[0].id).not.toBe(first.request.id)
    yield* first.service.reply({ requestID: renewed[0].id, reply: { scope: "session", policy: "R=S*" } })
    yield* Fiber.join(first.fiber)
  }),
)

it.effect("real durable listener interruption must not retain authorization from a failed reply", () =>
  Effect.gen(function* () {
    yield* setup()
    const first = yield* waitForRequest({
      action: "external_directory", operations: ["read"], paths: ["D:/project"],
      directories: ["D:/project"], resources: ["D:/project/*"],
    })
    const bus = yield* Bus.Service
    const unsubscribe = yield* bus.listen((event) =>
      event.type === SessionEvent.Permissions.type ? Effect.interrupt : Effect.void)
    const attempt = yield* first.service.reply({
      requestID: first.request.id, reply: { scope: "session", policy: "R=S*" },
    }).pipe(Effect.forkScoped)
    const exit = yield* Fiber.await(attempt)
    yield* unsubscribe
    expect(Exit.isFailure(exit)).toBe(true)
    expect(first.fiber.pollUnsafe()).toBeUndefined()
    const renewed = yield* first.service.list()
    expect(renewed).toHaveLength(1)
    expect(renewed[0].id).not.toBe(first.request.id)
    const { db } = yield* Database.Service
    const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, first.request.sessionID)).get().pipe(Effect.orDie)
    expect(row?.permission ?? []).toEqual([])
    expect(yield* first.service.allows(assertion({
      operations: ["read"], paths: ["D:/project/a"], resources: ["D:/project/a"],
    }))).toBe(false)
  }),
)

it.effect("deny installed during Replied publication prevents the durable approval", () =>
  Effect.gen(function* () {
    yield* setup()
    const first = yield* waitForRequest({
      action: "external_directory", operations: ["read"], paths: ["D:/project"],
      directories: ["D:/project"], resources: ["D:/project/*"],
    })
    const bus = yield* Bus.Service
    const context = yield* Effect.context<Agent.Service | Scope.Scope>()
    const unsubscribe = yield* bus.listen((event) =>
      event.type === Permission.Event.Replied.type && (event.data as { requestID: Permission.ID }).requestID === first.request.id
        ? setRules([{ action: "external_directory", resource: "*", effect: "deny" }]).pipe(Effect.provide(context))
        : Effect.void)
    const exit = yield* Effect.exit(first.service.reply({
      requestID: first.request.id, reply: { scope: "session", policy: "R=S*" },
    }))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(first.fiber.pollUnsafe()).toBeUndefined()
    const renewed = yield* first.service.list()
    expect(renewed).toHaveLength(1)
    expect(renewed[0].id).not.toBe(first.request.id)
    const { db } = yield* Database.Service
    const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, first.request.sessionID)).get().pipe(Effect.orDie)
    expect(row?.permission ?? []).toEqual([])
    yield* unsubscribe
    yield* first.service.reply({ requestID: renewed[0].id, reply: "reject" })
    expect(Exit.isFailure(yield* Fiber.await(first.fiber))).toBe(true)
  }),
)

for (const policy of ["Unknown=S", "Unknown=SE", "Unknown=SEA", "Whole=SEA"] as const) {
  it.effect(`${policy}: a failed durable proposal leaves no grant or replayable authorization and requires explicit retry`, () =>
    Effect.gen(function* () {
      yield* setup()
      const command = "& 'C:/Progs/node-v24_17/node.exe' --test 'D:/project/test/a.test.mjs'"
      const unknown = {
        action: "shell", resources: [command],
        metadata: { filesystemEffects: "unknown", unknownCommand: command, unknownCwd: "D:/project", unknownShell: "powershell.exe" },
      }
      const first = yield* waitForRequest(unknown)
      const bus = yield* Bus.Service
      const unsubscribe = yield* bus.listen((event) =>
        event.type === SessionEvent.Permissions.type ? Effect.die(new Error("injected durable proposal failure")) : Effect.void)
      expect(Exit.isFailure(yield* Effect.exit(first.service.reply({
        requestID: first.request.id, reply: { scope: "session", policy },
      })))).toBe(true)
      expect(first.fiber.pollUnsafe()).toBeUndefined()
      const renewed = yield* first.service.list()
      expect(renewed).toHaveLength(1)
      expect(renewed[0].id).not.toBe(first.request.id)
      expect(Exit.isFailure(yield* Effect.exit(first.service.reply({ requestID: first.request.id, reply: "once" })))).toBe(true)
      const { db } = yield* Database.Service
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, first.request.sessionID)).get().pipe(Effect.orDie)
      expect(row?.permission ?? []).toEqual([])
      expect(yield* first.service.allows(assertion(unknown))).toBe(false)
      const history = yield* bus.log({ aggregateID: first.request.sessionID, follow: false }).pipe(Stream.runCollect)
      expect(history.filter((event) => event.type === SessionEvent.Permissions.type)).toEqual([])
      yield* unsubscribe
      yield* first.service.reply({ requestID: renewed[0].id, reply: { scope: "session", policy } })
      yield* Fiber.join(first.fiber)
      expect(yield* first.service.allows(assertion(unknown))).toBe(true)
    }),
  )
}

it.effect("checked permission proposals precede persistence; streams contain only the successful commit", () =>
  Effect.gen(function* () {
    yield* setup()
    const first = yield* waitForRequest({
      action: "external_directory", operations: ["read"], paths: ["D:/project"],
      directories: ["D:/project"], resources: ["D:/project/*"],
    })
    const bus = yield* Bus.Service
    const { db } = yield* Database.Service
    let calls = 0
    const unsubscribe = yield* bus.listen((event) => Effect.gen(function* () {
      if (event.type !== SessionEvent.Permissions.type) return
      calls++
      expect(event.durable).toBeUndefined()
      const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, first.request.sessionID)).get().pipe(Effect.orDie)
      expect(row?.permission ?? []).toEqual([])
      expect(first.fiber.pollUnsafe()).toBeUndefined()
    }))
    const stream = yield* bus.subscribe(SessionEvent.Permissions).pipe(Stream.take(1), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    let fail = true
    yield* bus.project(SessionEvent.Permissions, () => Effect.suspend(() => {
      if (!fail) return Effect.void
      fail = false
      return Effect.die(new Error("projection failed after proposal"))
    }))
    expect(Exit.isFailure(yield* Effect.exit(first.service.reply({
      requestID: first.request.id, reply: { scope: "session", policy: "R=S*" },
    })))).toBe(true)
    expect(stream.pollUnsafe()).toBeUndefined()
    const renewed = yield* first.service.list()
    yield* first.service.reply({ requestID: renewed[0].id, reply: { scope: "session", policy: "R=S*" } })
    yield* Fiber.join(first.fiber)
    const received = yield* Fiber.join(stream)
    expect(calls).toBe(2)
    expect(received).toHaveLength(1)
    expect(received[0].durable).toBeDefined()
    expect(received[0].data.permissions.some((rule) => rule.effect === "allow")).toBe(true)
    yield* unsubscribe
  }),
)

it.effect("a deny installed by a durable proposal observer prevents the final commit", () =>
  Effect.gen(function* () {
    yield* setup()
    const first = yield* waitForRequest({
      action: "external_directory", operations: ["read"], paths: ["D:/project"],
      directories: ["D:/project"], resources: ["D:/project/*"],
    })
    const bus = yield* Bus.Service
    const context = yield* Effect.context<Agent.Service | Scope.Scope>()
    const unsubscribe = yield* bus.listen((event) => event.type === SessionEvent.Permissions.type
      ? setRules([{ action: "external_directory", resource: "*", effect: "deny" }]).pipe(Effect.provide(context))
      : Effect.void)
    expect(Exit.isFailure(yield* Effect.exit(first.service.reply({
      requestID: first.request.id, reply: { scope: "session", policy: "R=S*" },
    })))).toBe(true)
    expect(first.fiber.pollUnsafe()).toBeUndefined()
    const { db } = yield* Database.Service
    const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, first.request.sessionID)).get().pipe(Effect.orDie)
    expect(row?.permission ?? []).toEqual([])
    const renewed = yield* first.service.list()
    expect(renewed).toHaveLength(1)
    expect(renewed[0].id).not.toBe(first.request.id)
    yield* unsubscribe
  }),
)

it.effect("a concurrent durable update during proposal survives CAS retry and stream order stays increasing", () =>
  Effect.gen(function* () {
    yield* setup()
    const first = yield* waitForRequest({
      action: "external_directory", operations: ["read"], paths: ["D:/project"],
      directories: ["D:/project"], resources: ["D:/project/*"],
    })
    const bus = yield* Bus.Service
    const unrelated = { action: "unrelated", resource: "*", effect: "ask" as const }
    let once = true
    const unsubscribe = yield* bus.listen((event) => {
      if (event.type !== SessionEvent.Permissions.type || !once) return Effect.void
      once = false
      return bus.publish(SessionEvent.Permissions, {
        sessionID: first.request.sessionID, permissions: [unrelated],
      }).pipe(Effect.asVoid)
    })
    const stream = yield* bus.subscribe(SessionEvent.Permissions).pipe(Stream.take(2), Stream.runCollect, Effect.forkScoped)
    yield* Effect.yieldNow
    yield* first.service.reply({ requestID: first.request.id, reply: { scope: "session", policy: "R=S*" } })
    yield* Fiber.join(first.fiber)
    const events = yield* Fiber.join(stream)
    expect(events.map((event) => Number(event.durable.seq))).toEqual([0, 1])
    const sessions = yield* SessionStore.Service
    const stored = yield* sessions.get(first.request.sessionID)
    expect(stored?.permissions).toContainEqual(unrelated)
    expect(stored?.permissions?.some((rule) => rule.effect === "allow")).toBe(true)
    yield* unsubscribe
  }),
)

it.effect("nested unknown-shell approval uses the parent row but remains exact to the requesting session and command", () =>
  Effect.gen(function* () {
    const parentSession = Session.ID.make("ses_test")
    const childSession = Session.ID.make("ses_nested_unknown_child")
    yield* setup([{ action: "*", resource: "*", effect: "allow" }], parentSession)
    yield* setup([{ action: "*", resource: "*", effect: "allow" }], childSession)
    const { db } = yield* Database.Service
    yield* db.update(SessionTable).set({ parent_id: parentSession }).where(eq(SessionTable.id, childSession)).run().pipe(Effect.orDie)
    const service = yield* Permission.Service
    const source = { type: "tool" as const, messageID: "msg_test", id: "call_child" }
    const metadata = {
      filesystemEffects: "unknown", unknownCommand: "npm run dev",
      unknownCwd: "/project", unknownShell: "powershell.exe",
    }
    const input = { sessionID: childSession, action: "shell", resources: ["npm run dev"], metadata, source }
    yield* Effect.scoped(Effect.gen(function* () {
      yield* service.nested(Tool.CallID.make("call_child"), Tool.CallID.make("call_parent"))
      const first = yield* service.ask(assertion({ ...input, id: Permission.ID.create("per_nested_unknown") }))
      expect(first.effect).toBe("ask")
      const pending = yield* service.get(first.id)
      expect(pending?.source).toEqual({ ...source, id: "call_parent" })
      expect(pending?.metadata).toEqual(metadata)
      expect(pending?.sessionID).toBe(childSession)
      yield* service.reply({ requestID: first.id, reply: { scope: "session", policy: "Unknown=S" } })
      expect(yield* service.get(first.id)).toBeUndefined()
      expect((yield* service.ask(assertion({ ...input, id: Permission.ID.create("per_nested_unknown_same") }))).effect).toBe("allow")
      for (const [id, changed] of [
        ["per_nested_unknown_command", { metadata: { ...metadata, unknownCommand: "npm run build" } }],
        ["per_nested_unknown_cwd", { metadata: { ...metadata, unknownCwd: "/other" } }],
        ["per_nested_unknown_shell", { metadata: { ...metadata, unknownShell: "other.exe" } }],
        ["per_nested_unknown_session", { sessionID: parentSession }],
      ] as const) {
        const result = yield* service.ask(assertion({ ...input, ...changed, id: Permission.ID.create(id) }))
        expect(result.effect).toBe("ask")
        expect((yield* service.get(result.id))?.source).toEqual({ ...source, id: "call_parent" })
        yield* service.reply({ requestID: result.id, reply: "once" })
      }
    }))
    const after = yield* service.ask(assertion({
      ...input, id: Permission.ID.create("per_nested_unknown_after"),
      metadata: { ...metadata, unknownCommand: "different" },
    }))
    expect(after.effect).toBe("ask")
    expect((yield* service.get(after.id))?.source).toEqual(source)
    yield* service.reply({ requestID: after.id, reply: "once" })
  }),
)
