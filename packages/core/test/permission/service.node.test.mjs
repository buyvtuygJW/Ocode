import { test } from "node:test"
import assert from "node:assert/strict"
import { registerHooks, createRequire } from "node:module"
import { pathToFileURL, fileURLToPath } from "node:url"
import { existsSync } from "node:fs"

// No build, install, Bun, live sessions or production database. Only host I/O/services are replaced;
// Permission.layer, canonical SessionEvent, SQL declarations, pending handling and CRUD matching
// are production. SQLite, Bus transaction/dispatch and projector execution remain synthetic adapters.
const local = createRequire(import.meta.url)
const effectURL = process.env.PERSONALIZE_EFFECT ?? pathToFileURL(local.resolve("effect")).href
const fixtureURL = new URL("./service-fixture.mjs", import.meta.url).href
const root = new URL("../../../", import.meta.url)
const stubs = new Set([
  "agent.js", "bus.js", "location/index.js", "session/store.js", "session/projector.js", "session/errors.js",
  "permission/saved.js", "plugin/hooks.js", "database/database.js", "session/sql.js",
  "layer/location-node.js", "project/schema.js", "location.js", "session/error.js", "session/schema.js",
])
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "effect") return { url: effectURL, shortCircuit: true }
    if (specifier === "@opencode/util/effect/app-node") return { url: fixtureURL, shortCircuit: true }
    if (specifier === "drizzle-orm") return { url: fixtureURL, shortCircuit: true }
    if (specifier === "drizzle-orm/sqlite-core") return { url: fixtureURL, shortCircuit: true }
    if (context.parentURL?.endsWith("/core/src/session/sql.ts") &&
      ["../database/path.js", "../database/schema.sql.js", "../project/sql.js"].includes(specifier))
      return { url: fixtureURL, shortCircuit: true }
    if (context.parentURL?.endsWith("/core/src/permission.ts") && stubs.has(specifier.replace(/^\.\//, "")))
      return { url: fixtureURL, shortCircuit: true }
    if (specifier.startsWith("@opencode/schema/"))
      return { url: new URL(`schema/src/${specifier.slice("@opencode/schema/".length)}.ts`, root).href, shortCircuit: true }
    if (specifier.startsWith("@opencode/util/"))
      return { url: new URL(`util/src/${specifier.slice("@opencode/util/".length)}.ts`, root).href, shortCircuit: true }
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const url = new URL(specifier, context.parentURL)
      if (url.pathname.endsWith(".js")) url.pathname = url.pathname.slice(0, -3) + ".ts"
      if (!/\.[a-z]+$/i.test(url.pathname)) url.pathname += ".ts"
      if (existsSync(fileURLToPath(url))) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (/\/schema\/src\/(agent|session)\.ts$/.test(url)) {
      const name = url.endsWith("/agent.ts") ? "Agent" : "Session"
      return { format: "module", shortCircuit: true, source:
        `import {Schema} from "effect"; export const ID=Schema.String; export const ${name}={ID};` }
    }
    return next(url, context)
  },
})
const { Effect, Layer, Fiber, Exit } = await import("effect")
const { fixture } = await import("./service-fixture.mjs")
const { SessionTable } = await import("../../src/session/sql.ts")
const { EventSequenceTable } = await import("../../src/event/sql.ts")
const Permission = await import("../../src/permission.ts")
const { SessionEvent } = await import("@opencode/schema/session-event")
const state = fixture(SessionTable, EventSequenceTable)
const dependencies = () => Layer.mergeAll(...state.services.map(([key, value]) => Layer.succeed(key, value)))
const run = (body) => Effect.runPromise(Effect.scoped(body.pipe(
  Effect.provide(Layer.provide(Permission.node.layer, dependencies())),
)).pipe(Effect.timeout("10 seconds")))
const input = (sessionID = "ses_child", operation = "read", paths = ["D:/Data/Project/deep/file"]) => ({
  sessionID, agent: "build", action: operation === "read" ? "read" : "edit",
  operations: [operation], paths, resources: paths, access: "content",
})
const pending = (service, request) => Effect.gen(function* () {
  const fiber = yield* service.assert(request).pipe(Effect.forkChild)
  while (true) {
    const match = (yield* service.list()).find((item) => item.sessionID === request.sessionID && item.action === request.action)
    if (match) return { fiber, request: match }
    const status = fiber.pollUnsafe()
    if (status !== undefined) {
      if (Exit.isFailure(status)) return yield* status
      throw new Error("Expected a pending permission request, but assertion completed")
    }
    yield* Effect.yieldNow
  }
})

test("real Permission service: durable family CRUD, atomic invalid input, denies, unrelated roots, restart and revocation", async () => {
  state.add("ses_root")
  const unrelatedRule = { action: "unrelated_tool", resource: "*", effect: "ask" }
  state.records.set("ses_root", {
    ...state.records.get("ses_root"), permissions: [unrelatedRule], metadata: { retained: "root annotation" },
  })
  state.add("ses_child", "ses_root")
  state.add("ses_grandchild", "ses_child")
  state.add("ses_unrelated")
  await run(Effect.gen(function* () {
    const service = yield* Permission.Service
    const first = yield* pending(service, {
      ...input("ses_root"), action: "external_directory", paths: ["D:/Data/Project"],
      resources: ["D:/Data/Project/*"], save: ["D:/Data/*"],
    })
    const second = yield* pending(service, input())
    const unrelated = yield* pending(service, input("ses_unrelated"))
    const before = JSON.stringify([...state.records])
    const invalid = yield* service.reply({
      requestID: first.request.id, reply: { scope: "session", policy: "R=S* R=D*" },
    }).pipe(Effect.flip)
    assert.equal(invalid._tag, "Permission.InvalidPolicyError")
    assert.equal(JSON.stringify([...state.records]), before)
    assert.equal((yield* service.list()).length, 3)
    yield* service.reply({ requestID: first.request.id, reply: { scope: "session", policy: "RU=S* CD=D*" } })
    yield* Fiber.join(first.fiber)
    yield* Fiber.join(second.fiber)
    state.add("ses_future", "ses_child")
    assert.equal((yield* service.ask(input("ses_future"))).effect, "allow")
    assert.deepEqual((yield* service.list()).map((item) => item.id), [unrelated.request.id])
    for (const op of ["read", "update", "create", "delete"])
      assert.equal((yield* service.ask(input("ses_grandchild", op))).effect,
        op === "read" || op === "update" ? "allow" : "deny")
    assert.equal((yield* service.ask(input("ses_child", "read", ["D:/Data/Project-other/file"]))).effect, "ask")
    state.agentRules.push({ action: "shell", resource: "*", effect: "allow" })
    const opaque = yield* service.assert({
      ...input(), action: "shell", metadata: { filesystemEffects: "unknown" },
    }).pipe(Effect.flip)
    assert.equal(opaque._tag, "Permission.BlockedError")
    assert.match(opaque.reason, /unknown local filesystem effects/)
    state.agentRules.push({ action: "read", resource: "*", effect: "deny" })
    assert.equal((yield* service.ask(input())).effect, "deny")
    state.agentRules.push({ action: "edit", resource: "*", effect: "deny" })
    assert.equal((yield* service.ask(input("ses_child", "update"))).effect, "deny")
    state.agentRules.length = 0
    assert.equal(state.saved.length, 0)
    assert.equal(state.durable.length, 1)
    assert.equal(state.durable[0].type, "session.permissions")
    assert.equal(state.durable[0].seq, 0)
    assert.deepEqual(state.durable[0].data.permissions, state.records.get("ses_root").permissions)
    assert.deepEqual(state.records.get("ses_root").permissions[0], unrelatedRule)
    assert.deepEqual(state.records.get("ses_root").metadata, { retained: "root annotation" })
    yield* service.reply({ requestID: unrelated.request.id, reply: "once" })
    yield* Fiber.join(unrelated.fiber)
  }))
  const beforeReplay = JSON.stringify(state.records.get("ses_root"))
  state.replay()
  assert.equal(JSON.stringify(state.records.get("ses_root")), beforeReplay)
  // A fresh scoped Permission.layer must read the replayed projection, not an in-memory policy map.
  await run(Effect.gen(function* () {
    const service = yield* Permission.Service
    assert.equal((yield* service.ask(input())).effect, "allow")
    assert.equal((yield* service.ask(input("ses_child", "create"))).effect, "deny")
    // Same event used by the existing session permissions PATCH / Session.setPermissions.
    yield* state.publishDurable(SessionEvent.Permissions, { sessionID: "ses_root", permissions: [unrelatedRule] })
    assert.equal((yield* service.ask(input())).effect, "ask")
    assert.deepEqual(state.records.get("ses_root").permissions, [unrelatedRule])
    state.replay()
    assert.equal(yield* service.allows(input()), false, "replay must not resurrect revoked grants")
  }))
})

test("actual SQL metadata is singular and canonical session permissions events are durable", () => {
  assert.equal(SessionTable.permission.name, "permission")
  assert.equal(SessionTable.permissions, undefined)
  assert.equal(SessionEvent.Permissions.type, "session.permissions")
  assert.equal(SessionEvent.Permissions.durable.aggregate, "sessionID")
})

test("stale durable snapshot rolls back, retries and preserves a concurrent approval and unrelated session fields", async () => {
  const original = { action: "baseline_tool", resource: "*", effect: "deny" }
  const concurrent = { action: "concurrent_tool", resource: "*", effect: "ask" }
  state.records.set("ses_root", {
    ...state.records.get("ses_root"), permissions: [original], metadata: { keep: "not a policy field" },
  })
  await run(Effect.gen(function* () {
    const service = yield* Permission.Service
    const first = yield* pending(service, {
      ...input("ses_root", "read", ["D:/Data/First/file"]),
      action: "external_directory", resources: ["D:/Data/First/*"],
    })
    const second = yield* pending(service, {
      ...input("ses_child", "read", ["D:/Data/Second/file"]),
      action: "external_directory", resources: ["D:/Data/Second/*"],
    })
    const logStart = state.durable.length
    const traceStart = state.trace.length
    const seq = state.sequences.get("ses_root")
    state.afterSnapshot(() => Effect.gen(function* () {
      // Interleave an ordinary Session.setPermissions-style update and a second user approval
      // after the first snapshot, but before its durable publication acquires the Bus lock.
      yield* state.publishDurable(SessionEvent.Permissions, {
        sessionID: "ses_root", permissions: [...state.records.get("ses_root").permissions, concurrent],
      })
      yield* service.reply({ requestID: second.request.id, reply: { scope: "session", policy: "R=S*" } })
    }))
    yield* service.reply({ requestID: first.request.id, reply: { scope: "session", policy: "R=S*" } })
    yield* Fiber.join(first.fiber)
    yield* Fiber.join(second.fiber)
    assert.equal(yield* service.allows(input("ses_child", "read", ["D:/Data/First/file"])), true)
    assert.equal(yield* service.allows(input("ses_child", "read", ["D:/Data/Second/file"])), true)
    const root = state.records.get("ses_root")
    assert.deepEqual(root.permissions.filter((rule) => !rule.action.startsWith("__opencode_")), [original, concurrent])
    assert.deepEqual(root.metadata, { keep: "not a policy field" })
    const committed = state.durable.slice(logStart)
    assert.equal(committed.length, 3, "the stale publication must not append a durable event")
    assert.deepEqual(committed.map((event) => event.seq), [seq + 1, seq + 2, seq + 3])
    const trace = state.trace.slice(traceStart)
    assert.equal(trace.filter((step) => step === "rollback").length, 1)
    assert.equal(trace.filter((step) => step === "notify:session.permissions").length, 3)
    assert.equal((yield* service.list()).length, 0)
    const expected = JSON.stringify(root)
    state.replay()
    assert.equal(JSON.stringify(state.records.get("ses_root")), expected)
  }))
})

test("real service rechecks a request registered concurrently with a grant", async () => {
  await run(Effect.gen(function* () {
    const service = yield* Permission.Service
    const first = yield* pending(service, {
      ...input("ses_root"), action: "external_directory", paths: ["D:/Data/Project"], resources: ["D:/Data/Project/*"],
    })
    state.publish((payload) => {
      if (payload.id && payload.id !== first.request.id) {
        state.publish(undefined)
        return service.reply({ requestID: first.request.id, reply: { scope: "session", policy: "R=S*" } })
      }
      return Effect.void
    })
    yield* service.assert(input())
    yield* Fiber.join(first.fiber)
    assert.equal((yield* service.list()).length, 0)
  }))
})

test("real service keeps parent-list-only content pending and consumes R=-1 exactly once", async () => {
  state.records.set("ses_root", { ...state.records.get("ses_root"), permissions: [] })
  await run(Effect.gen(function* () {
    const service = yield* Permission.Service
    const content = yield* pending(service, {
      ...input("ses_root"), action: "external_directory", paths: ["D:/Data/Project/file"],
      resources: ["D:/Data/Project/*"],
    })
    yield* service.reply({ requestID: content.request.id, reply: { scope: "session", policy: "R=-1" } })
    assert.equal((yield* service.list()).length, 1)
    const listing = { ...input("ses_root", "read", ["D:/Data"]), access: "listing" }
    assert.equal(yield* service.allows({ ...listing, access: "content" }), false)
    yield* service.assert(listing)
    assert.equal(yield* service.allows(listing), false)
    yield* service.reply({ requestID: content.request.id, reply: { scope: "session", policy: "R=-S" } })
    assert.equal((yield* service.list()).length, 1)
    assert.equal((yield* service.ask({ ...listing, sessionID: "ses_grandchild" })).effect, "allow")
    assert.equal((yield* service.ask(input("ses_grandchild", "read", ["D:/Data/sibling/file"]))).effect, "ask")
    yield* service.reply({ requestID: content.request.id, reply: "once" })
    yield* Fiber.join(content.fiber)
  }))
  await run(Effect.gen(function* () {
    const service = yield* Permission.Service
    assert.equal((yield* service.ask({ ...input("ses_child", "read", ["D:/Data"]), access: "listing" })).effect, "allow")
    assert.equal((yield* service.ask(input("ses_child", "read", ["D:/Data/parent-file"]))).effect, "ask")
  }))
})

test("real service =1 settles only the selected request, unlike durable session policy", async () => {
  state.records.set("ses_root", { ...state.records.get("ses_root"), permissions: [] })
  await run(Effect.gen(function* () {
    const service = yield* Permission.Service
    const selected = yield* pending(service, {
      ...input("ses_root"), directories: ["D:/Data/Project"], // Ordinary read prompts also offer exact directories.
    })
    const other = yield* pending(service, input("ses_child"))
    yield* service.reply({ requestID: selected.request.id, reply: { scope: "session", policy: "R=1*" } })
    yield* Fiber.join(selected.fiber)
    assert.deepEqual((yield* service.list()).map((item) => item.id), [other.request.id])
    assert.equal((yield* service.ask(input())).effect, "ask")
    assert.deepEqual(state.records.get("ses_root").permissions, [])
    yield* service.reply({ requestID: other.request.id, reply: "once" })
    yield* Fiber.join(other.fiber)
  }))
})

test("existing persistent always remains project-scoped and survives service recreation", async () => {
  await run(Effect.gen(function* () {
    const service = yield* Permission.Service
    const selected = yield* pending(service, { ...input(), save: ["D:/Data/Project/*"] })
    yield* service.reply({ requestID: selected.request.id, reply: "always" })
    yield* Fiber.join(selected.fiber)
    assert.equal(state.saved.length, 1)
    assert.deepEqual(state.records.get("ses_root").permissions, [])
  }))
  await run(Effect.gen(function* () {
    const service = yield* Permission.Service
    assert.equal((yield* service.ask(input("ses_unrelated"))).effect, "allow")
    assert.equal(yield* service.allows(input("ses_child", "read", ["D:/Data/Project-other/file"])), false)
    assert.equal(yield* service.allows(input("ses_child", "update")), false)
  }))
})
