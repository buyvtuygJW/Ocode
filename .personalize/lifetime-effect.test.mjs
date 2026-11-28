import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { stripTypeScriptTypes } from "node:module"
import { test } from "node:test"
import { Lifetime, defaults, duration } from "../packages/util/src/personalize-lifetime.ts"

const runtime = await import(process.env.PERSONALIZE_EFFECT ?? "effect")
const { Context, Deferred, Effect, Fiber, Layer, Option, Schema } = runtime

// Exercise the actual owned factories with the actual pinned Effect runtime;
// only the host services are test doubles. No server or child processes.
function load(relative, dependencies, names = ["decorate"], extra = {}) {
  return loadSource(fs.readFileSync(new URL(`../${relative}`, import.meta.url), "utf8"), dependencies, names, extra)
}

function loadSource(source, dependencies, names, extra = {}) {
  let code = stripTypeScriptTypes(source, { mode: "transform" })
  code = code.replace(/^export \* as \w+ from ["'][^"']+["'];?$/gm, "")
  code = code.replace(/^import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["'];?$/gm,
    (_, fields, specifier) => `const {${fields.replace(/\bas\b/g, ":")}} = deps[${JSON.stringify(specifier)}];`)
  code = code.replace(/^import\s+(\w+)\s+from\s+["']([^"']+)["'];?$/gm,
    (_, name, specifier) => `const ${name} = deps[${JSON.stringify(specifier)}];`)
  code = code.replace(/^export /gm, "")
  return new Function("deps", ...Object.keys(extra), `${code}\nreturn {${names.join(",")}}`)(dependencies, ...Object.values(extra))
}

function graph(tag, service) {
  return {
    mapLayer: (f) => ({ layer: f(Layer.succeed(tag, service)) }),
    replace: (replacement) => ({ tag, ...replacement }),
  }
}

function jobLayer(service, policy) {
  const JobService = Context.Service()("test/JobLease")
  const ExecutionService = Context.Service()("test/ExecutionLease")
  let forwarded
  const { decorate } = load("packages/server/src/personalize/routes.ts", {
    effect: runtime,
    "@opencode/core/job": { Job: { Service: JobService, node: graph(JobService, service) } },
    "@opencode/core/session/execution": { SessionExecution: { Service: ExecutionService, node: graph(ExecutionService, {}) } },
    "@opencode/core/bus": { Bus: {} },
    "@opencode/schema/session-event": { SessionEvent: {} },
    "./idle-state": { lifetime: policy },
  })
  decorate({ createRoutes: (...args) => { forwarded = args } }).createRoutes({}, () => [], [])
  return { tag: JobService, layer: forwarded[2][0].layer }
}

const localJob = new URL("../packages/core/src/job.ts", import.meta.url)
const jobSource = fs.existsSync(localJob) ? localJob
  : process.env.PERSONALIZE_TEST_UPSTREAM && path.join(process.env.PERSONALIZE_TEST_UPSTREAM, "packages/core/src/job.ts")

test("actual Job.start joins, generations, cancellation and teardown release lifetime leases", async () => {
  assert.ok(jobSource, "Set PERSONALIZE_TEST_UPSTREAM when testing the owned-source tree without stock job.ts")
  const DatabaseService = Context.Service()("test/JobDatabase")
  const { make } = loadSource(fs.readFileSync(jobSource, "utf8"), {
    effect: runtime,
    "drizzle-orm": {},
    "@opencode/schema/job": { Job: {} },
    "@opencode/util/effect/app-node": { makeGlobalNode: (input) => input },
    "./bus.js": { Bus: { Service: Context.Service()("test/OptionalJobBus") } },
    "./database/database.js": { Database: { Service: DatabaseService } },
    "./job/list.js": { JobList: { read: () => Effect.succeed([]) } },
    "./job/recovery.js": { RecoverySchema: Schema.Unknown },
    "./job/sql.js": { JobTable: {} },
    "./session/message.js": { SessionMessage: { ID: Schema.String } },
    "./session/schema.js": { SessionSchema: { ID: Schema.String } },
  }, ["make"])
  const db = new Proxy({}, { get() { throw new Error("This regression must not perform database I/O") } })
  const policy = new Lifetime({ hardMs: 1000, softMs: 100 }, () => 0)
  policy.start()
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const stock = yield* make.pipe(Effect.provideService(DatabaseService, { db }))
    const wrapped = jobLayer(stock, policy)
    const jobs = Context.get(yield* Layer.build(wrapped.layer), wrapped.tag)
    const finish = yield* Deferred.make()
    let runs = 0
    const first = { id: "same-child", type: "subagent", run: Effect.sync(() => { runs++ }).pipe(
      Effect.andThen(Deferred.await(finish)), Effect.as("done"),
    ) }
    yield* jobs.start(first)
    assert.equal(policy.jobs, 1)
    yield* Effect.all(Array.from({ length: 8 }, () => jobs.start(first)), { concurrency: "unbounded" })
    assert.equal(runs, 1, "joined calls must not execute their supplied run")
    assert.equal(policy.jobs, 1, "joined calls must not acquire permanent job leases")
    assert.equal(policy.requests, 0)
    yield* Deferred.succeed(finish, undefined)
    yield* stock.wait({ id: first.id })
    assert.equal(policy.jobs, 0)
    assert.equal(policy.next().kind, "soft", "completion restores eligibility for soft shutdown")
    yield* jobs.start({ ...first, run: Effect.fail(new Error("new generation failed")) })
    yield* stock.wait({ id: first.id })
    assert.equal(policy.jobs, 0, "a failed generation releases exactly its own lease")
    yield* jobs.start({ id: "cancel", type: "shell", run: Effect.never })
    yield* jobs.start({ id: "survivor", type: "shell", run: Effect.never })
    assert.equal(policy.jobs, 2)
    yield* jobs.cancel("cancel")
    assert.equal(policy.jobs, 1, "cancellation must not release the other job's lease")
  })).pipe(Effect.timeout("5 seconds")))
  assert.equal(policy.jobs, 0, "registry teardown interrupts the remaining job and releases its lease")
  assert.equal(policy.requests, 0)
})

test("job admission is protected and releases on failure or interruption before a run starts", async () => {
  for (const interrupt of [false, true]) {
    const policy = new Lifetime({ hardMs: 1000, softMs: 100 }, () => 0)
    policy.start()
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const entered = yield* Deferred.make()
      const finish = yield* Deferred.make()
      const service = { start: () => Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(finish)),
        Effect.andThen(Effect.fail(new Error("admission failed"))),
      ) }
      const wrapped = jobLayer(service, policy)
      const jobs = Context.get(yield* Layer.build(wrapped.layer), wrapped.tag)
      const fiber = yield* jobs.start({ id: "admission", run: Effect.die("must not run") }).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      assert.equal(policy.requests, 1, "a pending start must prevent premature soft shutdown")
      assert.equal(policy.jobs, 0, "there is no execution lease before the actual run")
      assert.equal(policy.next().kind, "hard")
      if (interrupt) yield* Fiber.interrupt(fiber)
      else {
        yield* Deferred.succeed(finish, undefined)
        yield* Fiber.join(fiber).pipe(Effect.exit)
      }
      assert.equal(policy.requests, 0)
      assert.equal(policy.jobs, 0)
      assert.equal(policy.next().kind, "soft")
    })).pipe(Effect.timeout("5 seconds")))
  }
})

test("route seam forwards trailing arguments and counts real session/job lifetimes", async () => {
  const policy = new Lifetime(); policy.start(); policy.connect()
  const JobService = Context.Service()("test/Job")
  const ExecutionService = Context.Service()("test/Execution")
  const BusService = Context.Service()("test/Bus")
  const active = new Set()
  let subscriber, unsubscribed = false, forwarded
  const job = { start: ({ run }) => run.pipe(Effect.as("job-id")) }
  const execution = { active: Effect.sync(() => active) }
  const events = Object.fromEntries(["Started", "Succeeded", "Failed", "Interrupted"].map((name) => [name, { type: name }]))
  const { decorate } = load("packages/server/src/personalize/routes.ts", {
    effect: { Context, Effect, Layer, Option },
    "@opencode/core/job": { Job: { Service: JobService, node: graph(JobService, job) } },
    "@opencode/core/session/execution": { SessionExecution: { Service: ExecutionService, node: graph(ExecutionService, execution) } },
    "@opencode/core/bus": { Bus: { Service: BusService } },
    "@opencode/schema/session-event": { SessionEvent: { Execution: events } },
    "./idle-state": { lifetime: policy },
  })
  const options = {}, urls = () => [], caller = { caller: true }, instances = {}, future = {}
  decorate({ createRoutes: (...args) => { forwarded = args } }).createRoutes(options, urls, [caller], instances, future)
  assert.equal(forwarded[0], options); assert.equal(forwarded[1], urls)
  assert.equal(forwarded[2].at(-1), caller)
  assert.equal(forwarded[3], instances); assert.equal(forwarded[4], future)
  const bus = { listen: (fn) => Effect.sync(() => {
    subscriber = fn
    return Effect.sync(() => { unsubscribed = true })
  }) }
  const combined = Layer.mergeAll(...forwarded[2].slice(0, 2).map((replacement) => replacement.layer)).pipe(
    Layer.provide(Layer.succeed(BusService, bus)),
  )
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const context = yield* Layer.build(combined)
    const jobs = Context.get(context, JobService)
    yield* jobs.start({ run: Effect.sync(() => {
      assert.equal(policy.jobs, 1, "executing work owns a lease")
      assert.equal(policy.requests, 1, "admission is protected until start returns")
    }) })
    assert.equal(policy.jobs, 0)
    assert.equal(policy.requests, 0)
    yield* jobs.start({ run: Effect.fail(new Error("tool failed")) }).pipe(Effect.exit)
    assert.equal(policy.jobs, 0, "failed tools release their lease")
    assert.equal(policy.requests, 0, "a failed start releases admission")
    yield* subscriber({ type: "Started", data: { sessionID: "parent" } })
    yield* subscriber({ type: "Started", data: { sessionID: "child" } })
    yield* subscriber({ type: "Started", data: { sessionID: "child" } })
    assert.equal(policy.jobs, 2, "parallel sessions count separately; duplicate events do not")
    yield* subscriber({ type: "Succeeded", data: { sessionID: "parent" } })
    assert.equal(policy.jobs, 1)
    yield* subscriber({ type: "Interrupted", data: { sessionID: "child" } })
    assert.equal(policy.jobs, 0)
    active.add("unreported-session")
    assert.equal(policy.next(), undefined, "actual active-session state protects against a missing lifecycle event")
    active.clear()
  })))
  assert.equal(unsubscribed, true)
})

test("native commands show warnings, query status, and update without model/tool calls", async () => {
  let commandLayer, keyboard, request, toast, rendered
  const client = { url: "http://localhost:28894", headers: { Authorization: "test-auth" }, connection: { status: () => "connected" } }
  const { decorate } = load("packages/tui/src/personalize/lifetime.ts", {
    "@opencode/plugin/tui": { Plugin: { define: (plugin) => plugin } },
    "@opentui/solid": { useKeyboard: (fn) => { keyboard = fn } },
    "solid-js": {},
    "@opencode/util/personalize-lifetime": { defaults, duration },
    "../context/client": { useClient: () => client },
    "./lifetime-state": { wake: { wake() {} } },
  }, ["decorate"], { fetch: async (url, options) => {
    request = { url: String(url), ...options }
    return { ok: true, json: async () => ({ hardMs: 1000, softMs: 10000 }) }
  } })
  const original = {}
  const plugins = decorate({ builtins: [original] }).builtins
  assert.equal(plugins[0], original)
  plugins.at(-1).setup({
    ui: { slot: ({ render }) => { rendered = render }, toast: { show: (value) => { toast = value } } },
    keymap: { layer: (factory) => { commandLayer = factory() } },
  })
  rendered()
  assert.equal(typeof keyboard, "function")
  const hard = commandLayer.commands.find((command) => command.slash.name === "killtime")
  const soft = commandLayer.commands.find((command) => command.slash.name === "softkilltime")
  assert.match(hard.description, /priority.*unfinished work/)
  assert.match(soft.description, /all tasks, subagents and background tools/)
  await hard.run("1s")
  assert.equal(request.method, "PUT")
  assert.equal(request.headers.Authorization, "test-auth")
  assert.deepEqual(JSON.parse(request.body), { command: "killtime", duration: "1s" })
  assert.match(toast.message, /1s/)
  await soft.run()
  assert.equal(request.method, "GET")
})

test("watchdog cancels reconnect grace and reschedules after final disconnect", () => {
  let now = 0, timer, soft = 0, hard = 0
  const policy = new Lifetime({ hardMs: 1000, softMs: 100 }, () => now)
  const { armIdleWatchdog } = load("packages/server/src/personalize/idle-state.ts", {
    "@opencode/util/personalize-lifetime": { Lifetime: class { constructor() { return policy } } },
    "@opencode/util/personalize-lifetime-store": { settings: () => policy.settings, sleeping() {}, evictSelf() {} },
  }, ["armIdleWatchdog"], {
    setTimeout: (fn, ms) => (timer = { fn, ms, unref() {} }),
    clearTimeout: (handle) => { if (timer === handle) timer = undefined }, console: { error() {} },
  })
  const disarm = armIdleWatchdog(() => soft++, () => hard++)
  policy.start()
  const close = policy.connect()
  assert.equal(timer, undefined)
  now = 3000; close()
  assert.equal(timer.ms, 500)
  now = 3499; const reconnect = policy.connect()
  assert.equal(timer, undefined)
  now = 3600; reconnect()
  assert.equal(timer.ms, 500)
  now = 4100; timer.fn()
  assert.equal(soft, 1); assert.equal(hard, 0)
  disarm()
})

test("deadline timer invokes hard kill despite work", () => {
  let now = 0, callback, delay, soft = 0, hard = 0, marked
  const policy = new Lifetime({ hardMs: 1000, softMs: 500 }, () => now)
  const { armIdleWatchdog } = load("packages/server/src/personalize/idle-state.ts", {
    "@opencode/util/personalize-lifetime": { Lifetime: class { constructor() { return policy } } },
    "@opencode/util/personalize-lifetime-store": { settings: () => policy.settings, sleeping: (kind) => { marked = kind }, evictSelf() {} },
  }, ["armIdleWatchdog"], {
    setTimeout: (fn, ms) => { callback = fn; delay = ms; return { unref() {} } },
    clearTimeout: () => {}, console: { error() {} },
  })
  const disarm = armIdleWatchdog(() => soft++, () => hard++)
  policy.start(); policy.work()
  assert.equal(delay, 1000)
  now = 1000; callback()
  assert.equal(hard, 1); assert.equal(soft, 0); assert.equal(marked, "hard")
  disarm()
})

test("soft cleanup hanging does not disarm the eventual hard kill", () => {
  let now = 0, callback, delay, soft = 0, hard = 0
  const policy = new Lifetime({ hardMs: 1000, softMs: 500 }, () => now)
  const { armIdleWatchdog } = load("packages/server/src/personalize/idle-state.ts", {
    "@opencode/util/personalize-lifetime": { Lifetime: class { constructor() { return policy } } },
    "@opencode/util/personalize-lifetime-store": { settings: () => policy.settings, sleeping() {}, evictSelf() {} },
  }, ["armIdleWatchdog"], {
    setTimeout: (fn, ms) => { callback = fn; delay = ms; return { unref() {} } },
    clearTimeout() {}, console: { error() {} },
  })
  const disarm = armIdleWatchdog(() => { soft++ /* shutdown never finishes */ }, () => hard++)
  policy.start()
  assert.equal(delay, 500)
  now = 500; callback()
  assert.equal(soft, 1); assert.equal(hard, 0); assert.equal(delay, 500)
  now = 1000; callback()
  assert.equal(hard, 1)
  disarm()
})

test("marker or registration failure cannot block hard shutdown", () => {
  let now = 0, callback, delay, soft = 0, hard = 0
  const policy = new Lifetime({ hardMs: 1000, softMs: 500 }, () => now)
  const { armIdleWatchdog } = load("packages/server/src/personalize/idle-state.ts", {
    "@opencode/util/personalize-lifetime": { Lifetime: class { constructor() { return policy } } },
    "@opencode/util/personalize-lifetime-store": {
      settings: () => policy.settings,
      sleeping() { throw new Error("disk unavailable") },
      evictSelf() { throw new Error("registration locked") },
    },
  }, ["armIdleWatchdog"], {
    setTimeout: (fn, ms) => { callback = fn; delay = ms; return { unref() {} } },
    clearTimeout() {}, console: { error() {} },
  })
  const disarm = armIdleWatchdog(() => soft++, () => hard++)
  policy.start()
  now = 500; callback()
  assert.equal(soft, 0, "unsafe soft stop is withheld, not allowed to respawn-loop")
  assert.equal(delay, 500, "the hard deadline remains armed")
  now = 1000; callback()
  assert.equal(hard, 1, "disk/registration failures do not prevent force-kill")
  disarm()
})
