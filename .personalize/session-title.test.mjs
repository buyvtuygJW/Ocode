import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { isDeepStrictEqual } from "node:util"
import { test } from "node:test"
import path from "node:path"
import { pathToFileURL } from "node:url"

const runtime = await import(process.env.PERSONALIZE_EFFECT ?? "effect")
const { Context, DateTime, Deferred, Effect, Fiber, Layer, Stream } = runtime
const own = new URL("../", import.meta.url)
const stock = (file) => {
  const local = new URL(file, own)
  if (existsSync(local)) return local
  assert.ok(process.env.PERSONALIZE_TEST_TITLE_ROOT, "Provide the patched title source tree; this regression must not skip")
  return pathToFileURL(path.join(process.env.PERSONALIZE_TEST_TITLE_ROOT, file))
}
function load(file, deps, names) {
  let code = stripTypeScriptTypes(readFileSync(file, "utf8"), { mode: "transform" })
    .replace(/^export \* as \w+ from ["'][^"']+["'];?$/gm, "")
    .replace(/^import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["'];?$/gm,
      (_, fields, name) => `const {${fields.replace(/\bas\b/g, ":")}} = deps[${JSON.stringify(name)}];`)
    .replace(/^export /gm, "")
  return new Function("deps", `${code}\nreturn {${names.join(",")}}`)(deps)
}
const boundary = load(stock("packages/util/src/text-boundary.ts"), {}, ["head", "tail"])
const fallback = load(stock("packages/util/src/session-title-fallback.ts"), {}, ["isExactRootFallback", "displayLabel"])
const service = (name) => ({ Service: Context.Service()(`title-test/${name}`) })
const Bus = service("bus"), Database = service("database"), SessionStore = service("store")
const LLMClient = service("llm"), SessionContext = service("context")
const SessionEvent = { Renamed: { type: "renamed" }, UsageRecorded: { type: "usage" } }
const base = {
  effect: runtime,
  "../bus.js": { Bus }, "../database/database.js": { Database },
  "../session/event.js": { SessionEvent }, "../session/store.js": { SessionStore },
}
const naming = load(new URL("packages/core/src/personalize/session-naming.ts", own), base,
  ["dateTitle", "createTitleRenamer", "renameIfUnchanged"])
const message = (text) => ({ role: "user", content: [{ type: "text", text }] })
const first = { text: "Help debug this build" }
const model = { ref: { id: "model" }, cost: [], provider: "test", route: { endpoint: {}, providerMetadataKey: "test" } }
const selection = { agent: { id: "title" }, selected: model }
const text = (value) => Stream.make({ type: "textDelta", id: "title", text: value })
const titleRequest = load(new URL("packages/core/src/personalize/title-request.ts", own), {
  effect: runtime,
  "@opencode/ai/effect": { Message: { user: message }, SystemPart: { make: (text) => ({ text }) } },
  "@opencode/util/text-boundary": { TextBoundary: boundary },
}, ["prepareTitle"])

function fixture(options = {}) {
  const created = DateTime.makeUnsafe(new Date(2026, 6, 30, 18, 45, 3))
  let current = options.missing ? undefined : {
    id: "ses_title", title: options.title, parentID: options.parentID, time: { created },
  }
  let sequence = 0
  const requests = [], events = []
  const mutate = (title) => { current = { ...current, title }; sequence++ }
  const bus = {
    publish: (event, data, opts) => Effect.gen(function* () {
      if (event === SessionEvent.Renamed) {
        if (options.beforeCommit) { options.beforeCommit(mutate, () => sequence++); options.beforeCommit = undefined }
        // Commit validation represents the real Bus transaction's rollback boundary.
        if (opts?.commit) yield* opts.commit(sequence + 1)
        mutate(data.title)
      }
      events.push({ event, data })
    }),
  }
  const store = { get: () => Effect.sync(() => current) }
  const context = {
    selectTitle: () => options.selectError ? Effect.die("selection failed") : Effect.succeed(options.noModel ? undefined : selection),
    request: { title: (input) => Effect.sync(() => ({
      event: options.hook === undefined ? {} : { result: options.hook },
      request: { model, maxTokens: 100, system: input.system, messages: input.messages },
      options: {},
    })) },
  }
  const llm = {
    stream: (request) => {
      requests.push(request)
      assert.equal(current?.title, options.title ?? "2026-07-30-1845", "date must exist before a provider call")
      return options.stream ? options.stream(mutate) : text(options.output ?? "Tree")
    },
  }
  const dependencies = Layer.mergeAll(
    ...[[Bus, bus], [Database, { db: {} }], [SessionStore, store], [SessionContext, context], [LLMClient, llm]]
      .map(([key, value]) => Layer.succeed(key.Service, value)),
  )
  Bus.latestSequence = () => Effect.sync(() => sequence)
  const title = load(stock("packages/core/src/session/title.ts"), {
    effect: runtime, "node:util": { isDeepStrictEqual },
    "@opencode/ai/effect": {
      LLMClient, LLMEvent: { is: Object.fromEntries(["textStart", "textDelta", "textEnd", "stepFinish"]
        .map((type) => [type, (event) => event.type === type])) },
      Message: { user: message }, SystemPart: { make: (text) => ({ text }) },
    },
    "../database/database.js": { Database }, "../bus.js": { Bus },
    "@opencode/util/effect/app-node": { makeLocationNode: (node) => node },
    "@opencode/util/session-title-fallback": fallback,
    "@opencode/util/text-boundary": { TextBoundary: boundary },
    "../effect/app-node-platform.js": { llmClient: {} },
    "./context.js": { SessionContext }, "./event.js": { SessionEvent },
    "./history.js": { SessionHistory: { firstUserMessage: () => Effect.succeed(options.noUser ? undefined : options.first ?? first) } },
    "./usage.js": { SessionUsage: {} }, "./store.js": { SessionStore }, "./schema.js": {},
    "../personalize/session-naming.js": naming,
    "../personalize/title-request.js": titleRequest,
  }, ["Service", "layer", "isUntitled"])
  const run = (body) => Effect.runPromise(Effect.scoped(body.pipe(
    Effect.provide(Layer.provide(title.layer, dependencies)),
  )).pipe(Effect.timeout("5 seconds")))
  return { title, requests, events, dependencies, store, mutate, current: () => current, run,
    generate: () => run(Effect.flatMap(title.Service, (service) => service.generate("ses_title"))) }
}

for (const [name, options] of [
  ["no first message", { noUser: true }],
  ["no model or title agent", { noModel: true }],
  ["empty output", { output: "" }],
  ["blank output", { output: " \n" }],
  ["provider failure", { stream: () => Stream.fail({ _tag: "AI.Error" }) }],
  ["invalid multiword pseudonym", { output: "two words" }],
  ["oversized pseudonym", { output: "abcdef" }],
  ["non-alphanumeric pseudonym", { output: "🔥" }],
]) test(`dated fallback survives ${name}`, async () => {
  const state = fixture(options)
  await state.generate()
  assert.equal(state.current().title, "2026-07-30-1845")
  assert.equal(fallback.displayLabel(state.current()), "2026-07-30-1845")
  assert.equal(state.title.isUntitled(state.current()), true, "a fallback remains eligible for a later pseudonym")
})

for (const output of ["Tree", "字１２", "𐐀", "a1B2c"])
  test(`exact date and Unicode alphanumeric pseudonym: ${output}`, async () => {
    const state = fixture({ output })
    await state.generate()
    assert.equal(state.current().title, `2026-07-30-1845-${output}`)
    assert.equal(state.title.isUntitled(state.current()), false)
  })

test("hook titles use the same date and validation without requesting a model", async () => {
  const state = fixture({ hook: "Plug" })
  await state.generate()
  assert.equal(state.current().title, "2026-07-30-1845-Plug")
  assert.equal(state.requests.length, 0)
})

test("missing sessions remain absent", async () => {
  const state = fixture({ missing: true })
  await state.generate()
  assert.equal(state.current(), undefined)
  assert.equal(state.events.length, 0)
})

test("a model-selection defect still leaves the date", async () => {
  const state = fixture({ selectError: true })
  await assert.rejects(state.generate())
  assert.equal(state.current().title, "2026-07-30-1845")
})

test("manual titles survive failed regeneration", async () => {
  const state = fixture({ title: "Manual", stream: () => Stream.fail({ _tag: "AI.Error" }) })
  await state.generate()
  assert.equal(state.current().title, "Manual")
})

test("manual rename wins while generation is in flight", async () => {
  const state = fixture({ stream: (mutate) => { mutate("Manual"); return text("Tree") } })
  await state.generate()
  assert.equal(state.current().title, "Manual")
})

test("manual rename wins the fallback publication race", async () => {
  const state = fixture({ beforeCommit: (mutate) => mutate("Manual") })
  await state.generate()
  assert.equal(state.current().title, "Manual")
  assert.equal(state.requests.length, 0)
})

test("an unrelated session event cannot strand the plain fallback", async () => {
  const state = fixture({ noUser: true, beforeCommit: (_mutate, advance) => advance() })
  await state.generate()
  assert.equal(state.current().title, "2026-07-30-1845")
})

test("interrupted provider request cannot erase the date", async () => {
  const started = Deferred.makeUnsafe()
  const state = fixture({ stream: () => Stream.unwrap(
    Deferred.succeed(started, undefined).pipe(Effect.as(Stream.never)),
  ) })
  await state.run(Effect.gen(function* () {
    const title = yield* state.title.Service
    const fiber = yield* title.generate("ses_title").pipe(Effect.forkChild)
    yield* Deferred.await(started)
    yield* Fiber.interrupt(fiber)
  }))
  assert.equal(state.current().title, "2026-07-30-1845")
})

test("first-message clipping retains upstream Unicode safety and the 1,000-unit budget", async () => {
  const state = fixture({ first: { text: `x${"😀".repeat(1500)}` } })
  await state.generate()
  const prompt = state.requests[0].messages[0].content[0].text
  assert.equal(prompt.length, 999)
  assert.equal(prompt.isWellFormed(), true)
  assert.equal(state.requests[0].maxTokens, 20)
})

for (const options of [{}, { title: "Explicit" }, { parentID: "parent", title: "Council member" }])
  test(`public create decorator dates unnamed roots and preserves explicit/child names: ${JSON.stringify(options)}`, async () => {
    const state = fixture(options)
    const tag = Context.Service()("title-test/session")
    const original = { create: () => Effect.succeed(state.current()), other: Symbol("preserved") }
    const stock = { Service: tag, node: { mapLayer: (f) => ({ layer: f(Layer.succeed(tag, original)) }) } }
    const { decorate } = load(new URL("packages/core/src/personalize/session-create.ts", own), {
      ...base, "@opencode/util/session-title-fallback": fallback, "./session-naming": naming,
    }, ["decorate"])
    const layer = Layer.provide(decorate(stock).node.layer, state.dependencies)
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const session = yield* tag
      assert.equal(session.other, original.other)
      return yield* session.create(options)
    }).pipe(Effect.provide(layer))))
    assert.equal(result.title, options.title ?? "2026-07-30-1845")
  })
