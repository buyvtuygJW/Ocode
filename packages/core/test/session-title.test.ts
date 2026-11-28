import { beforeEach, expect } from "bun:test"
import {
  AIError,
  InvalidRequestError,
  LLMClient,
  LLMEvent,
  LanguageModel,
  Message,
  SystemPart,
  TransportError,
  type LLMRequest,
} from "@opencode/ai/effect"
import { OpenAIChat, OpenAIResponses } from "@opencode/ai/protocols"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SessionTitle } from "@opencode/core/session/title"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { PluginSupervisor } from "@opencode/core/plugin/supervisor"
import { Location } from "@opencode/core/location"
import { Session } from "@opencode/core/session"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { App } from "@opencode/core/app"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Money } from "@opencode/schema/money"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { testEffect } from "./lib/effect"

let requests: LLMRequest[] = []
let selectedSmall: Model.Info | undefined
let selectedPrimary: Model.Info | undefined
let selections: Array<Session.Info["model"]> = []
const model = LanguageModel.make({
  id: "title-model",
  provider: "test",
  route: OpenAIChat.route,
})
const smallModel = LanguageModel.make({
  id: "title-small",
  provider: "test",
  route: OpenAIChat.route,
})
const cost = [
  {
    input: Money.USDPerMillionTokens.make(1),
    output: Money.USDPerMillionTokens.make(2),
    cache: {
      read: Money.USDPerMillionTokens.make(0.1),
      write: Money.USDPerMillionTokens.make(0.5),
    },
  },
]
const providerRejected = (input: { readonly message: string }) =>
  new AIError({ reason: new InvalidRequestError(input) })

const successfulTitle = () =>
  Stream.make(
    LLMEvent.textDelta({ id: "title", text: "Tree\n" }),
    LLMEvent.stepFinish({
      index: 0,
      reason: { normalized: "stop" },
      usage: {
        inputTokens: 15,
        outputTokens: 6,
        nonCachedInputTokens: 10,
        cacheReadInputTokens: 3,
        cacheWriteInputTokens: 2,
        reasoningTokens: 2,
      },
    }),
    LLMEvent.finish({
      reason: { normalized: "stop" },
    }),
  )
let titleStream: (request: LLMRequest) => Stream.Stream<LLMEvent, AIError> = successfulTitle
const client = Layer.mock(LLMClient.Service)({
  stream: (request: LLMRequest) => {
    requests.push(request)
    return titleStream(request)
  },
  generate: () => Effect.die("unused"),
})
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: (session) => {
    selections.push(session.model)
    return Effect.succeed(
      SessionRunnerModel.resolved(session.model?.id === "title-small" ? smallModel : model, {
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        cost,
        limit: { context: 200_000, output: 32_000 },
        variant: session.model?.variant,
      }),
    )
  },
})
const smallModels = Layer.mock(Model.Service, {
  small: () => Effect.succeed(selectedSmall),
  get: (_providerID, modelID) => Effect.succeed(modelID === selectedPrimary?.id ? selectedPrimary : undefined),
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Agent.node,
      PluginHooks.node,
      SessionTitle.node,
    ]),
    [
      llmClient.replace(client),
      Model.node.replace(smallModels),
      SessionRunnerModel.node.replace(models),
      Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") })),
      PluginSupervisor.node.replace(Layer.empty),
    ],
  ),
)

const insertSession = (id: Session.ID, title?: string, created?: number, model?: Model.Ref) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title,
        model,
        time_created: created,
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const prompt = (sessionID: Session.ID, text: string) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const messageID = SessionMessage.ID.create()
    yield* bus.publish(SessionEvent.InboxEnqueued, {
      sessionID,
      inboxID: messageID,
      item: { type: "user", payload: { text }, delivery: "steer" },
    })
    yield* bus.publish(SessionEvent.InboxDelivered, {
      sessionID,
      inboxID: messageID,
    })
  })

const small = Model.Info.make({
  ...Model.Info.default(Provider.ID.make("test"), Model.ID.make("title-small")),
  family: Model.Family.make("gpt-luna"),
  capabilities: { tools: false, input: ["text"], output: ["text"] },
  variants: [
    { id: Model.VariantID.make("low") },
    { id: Model.VariantID.make("none") },
    { id: Model.VariantID.make("high") },
  ],
})
const lowSmall = Model.Info.make({
  ...small,
  variants: [{ id: Model.VariantID.make("low") }, { id: Model.VariantID.make("high") }],
})

beforeEach(() => {
  requests = []
  selectedSmall = undefined
  selectedPrimary = undefined
  selections = []
  titleStream = successfulTitle
})

const enableTitleAgent = Effect.gen(function* () {
  const agents = yield* Agent.Service
  yield* agents.transform((editor) => {
    editor.update(Agent.ID.make("title"), (agent) => {
      agent.mode = "primary"
      agent.hidden = true
      agent.system = "You are a title generator."
    })
  })
})

// Shared setup and parameterized contracts retain all original scenarios while
// checking exact creation-time titles rather than accepting any date-shaped text.
const created = new Date(2026, 6, 30, 18, 45, 3).getTime()
const stamp = "2026-07-30-1845"
const instruction = "Summarize: one word, max 5 chars, no spaces."
const primaryRef = (variant?: string) => Model.Ref.make({
  id: Model.ID.make("title-model"), providerID: Provider.ID.make("test"),
  ...(variant ? { variant: Model.VariantID.make(variant) } : {}),
})
const start = (options: {
  title?: string; first?: string | null; later?: string; enabled?: boolean
  created?: number; variant?: string; child?: boolean
} = {}) => Effect.gen(function* () {
  const id = Session.ID.create()
  if (options.enabled !== false) yield* enableTitleAgent
  if (options.child) {
    const parent = Session.ID.create()
    yield* insertSession(parent)
    const database = yield* Database.Service
    yield* database.db.insert(SessionTable).values({
      id, parent_id: parent, project_id: Project.ID.global, slug: id, directory: "/project",
      version: "test", time_created: options.created ?? created,
    }).run().pipe(Effect.orDie)
  } else yield* insertSession(id, options.title, options.created ?? created, primaryRef(options.variant))
  if (options.first !== null) yield* prompt(id, options.first ?? "Name this session")
  if (options.later) yield* prompt(id, options.later)
  const generator = yield* SessionTitle.Service
  const store = yield* SessionStore.Service
  const hooks = yield* PluginHooks.Service
  const bus = yield* Bus.Service
  return { id, hooks, bus, run: generator.generate(id), get: store.get(id) }
})
const output = (value: string) => Stream.make(
  LLMEvent.textDelta({ id: "title", text: value }), LLMEvent.finish({ reason: { normalized: "stop" } }),
)
function requestText() {
  expect(requests).toHaveLength(1)
  const request = requests[0]!
  expect(request.system.map((part) => part.text)).toEqual([instruction])
  expect(request.system.map((part) => part.text).join("").length).toBeLessThanOrEqual(55)
  expect(request.messages).toHaveLength(1)
  const part = request.messages[0]!.content[0]
  if (part?.type !== "text") throw new Error("Expected one user text input")
  expect(part.text.isWellFormed()).toBe(true)
  return part.text
}

it.effect("generates a title from the sole user message and renames the session", () => Effect.gen(function* () {
  const f = yield* start({ first: "Help me debug the failing build" })
  yield* f.run
  expect(requestText()).toBe("Help me debug the failing build")
  const request = requests[0]!
  expect(request.headers).toEqual({
    "x-opencode-session-id": f.id, "x-session-affinity": f.id, "X-Session-Id": f.id,
    "User-Agent": App.useragent(App.make()), "x-opencode-project": Project.ID.global,
    "x-opencode-session": f.id, "x-opencode-client": "opencode",
  })
  expect(request.promptCacheKey).toBe(f.id)
  expect(request.tools).toEqual([])
  const saved = yield* f.get
  expect(saved?.title).toBe(`${stamp}-Tree`)
  expect(saved?.tokens).toEqual({ input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 2 } })
  expect(saved?.cost).toBeCloseTo(0.0000233)
}))

for (const timing of ["start", "end"] as const) {
  it.effect(`excludes commentary from titles when the response phase arrives at ${timing}`, () => Effect.gen(function* () {
    const f = yield* start({ first: "Investigate performance across four hosts without making changes" })
    titleStream = (request) => {
      const events = [
        { type: "response.output_item.added", item: { type: "message", id: "commentary",
          ...(timing === "start" ? { phase: "commentary" } : {}) } },
        { type: "response.output_text.delta", item_id: "commentary",
          delta: "We need title only. Need capture investigation four machines performance read-only. Title concise." },
        { type: "response.output_item.done", item: { type: "message", id: "commentary", phase: "commentary" } },
        { type: "response.output_item.added", item: { type: "message", id: "final", phase: "final_answer" } },
        { type: "response.output_text.delta", item_id: "final", delta: "Speed" },
        { type: "response.output_item.done", item: { type: "message", id: "final", phase: "final_answer" } },
        { type: "response.completed", response: { id: "response_title" } },
      ]
      const decode = Schema.decodeUnknownSync(OpenAIResponses.protocol.stream.event)
      return Stream.fromIterable(events.map((event) => decode(JSON.stringify(event)))).pipe(
        Stream.mapAccumEffect(() => OpenAIResponses.protocol.stream.initial(request), OpenAIResponses.protocol.stream.step),
      )
    }
    yield* f.run
    expect(requests.length).toBe(1)
    expect((yield* f.get)?.title).toBe(`${stamp}-Speed`)
  }))
}

for (const scenario of [
  { name: "limits the instruction to 55 characters, retains 1,000 message characters, and prefixes the local datetime",
    first: `First message ${"x".repeat(8_000)}`, title: undefined, later: undefined,
    created: new Date(2026, 10, 15, 14, 32).getTime(), expected: "2026-11-15-1432-Tree", length: 1_000, contains: "First message ", excludes: [] },
  { name: "generates from the first user message after later messages exist",
    first: "First message", later: "Second message", title: undefined, created, expected: `${stamp}-Tree`,
    length: 13, contains: "First message", excludes: ["Second message"] },
  { name: "bounds the first message to 1,000 characters", title: "Original title", created,
    first: `ORIGINAL_GOAL ${"a".repeat(3_000)} OMITTED_ORIGINAL_END`,
    later: `OMITTED_OLD_CONTEXT ${"b".repeat(9_000)} RECENT_GOAL`, expected: `${stamp}-Tree`,
    length: 1_000, contains: "ORIGINAL_GOAL", excludes: ["RECENT_GOAL", "OMITTED_ORIGINAL_END", "OMITTED_OLD_CONTEXT"] },
  { name: "keeps the clipped regeneration context well formed", title: "Original title", created,
    first: `x${"😀".repeat(1_500)}`, later: `x${"😀".repeat(5_000)}`, expected: `${stamp}-Tree`,
    length: 999, contains: "x😀", excludes: [] },
]) it.effect(scenario.name, () => Effect.gen(function* () {
  const f = yield* start(scenario)
  yield* f.run
  const text = requestText()
  expect(text.length).toBe(scenario.length)
  expect(text.startsWith(scenario.contains)).toBe(true)
  for (const excluded of scenario.excludes) expect(text).not.toContain(excluded)
  expect(requests[0]!.maxTokens).toBe(20)
  expect((yield* f.get)?.title).toBe(scenario.expected)
}))

for (const scenario of [
  { name: "uses only the datetime if the pseudonym is invalid", value: "Too Long" },
  ...["", "   ", "two words", "toolong", "🔥"].map((value) =>
    ({ name: `keeps the creation date for empty or invalid title output ${JSON.stringify(value)}`, value })),
  ...[95, 96, 97].map((prefix) => ({ name: `rejects an oversized pseudonym with an emoji after ${prefix} letters`,
    value: `${"a".repeat(prefix)}😀${"b".repeat(20)}` })),
]) it.effect(scenario.name, () => Effect.gen(function* () {
  const f = yield* start()
  titleStream = () => output(scenario.value)
  yield* f.run
  expect(requests.length).toBe(1)
  expect((yield* f.get)?.title).toBe(stamp)
}))

for (const kind of ["redact", "smaller", "codex", "result"] as const) {
  const names = { redact: "runs title hooks instead of context hooks", smaller: "preserves a smaller provider output limit",
    codex: "omits the output limit for the ChatGPT Codex backend", result: "uses a hook-provided title without a model request" }
  it.effect(names[kind], () => Effect.gen(function* () {
    const f = yield* start({ first: "Redact this message" })
    let contexts = 0
    yield* f.hooks.register("session", "context", () => Effect.sync(() => { contexts++ }))
    yield* f.hooks.register("session", "title", (event) => Effect.sync(() => {
      expect(event.sessionID).toBe(f.id)
      expect(event.system.map((part) => part.text)).toEqual([instruction])
      if (kind === "redact") {
        event.system.push(SystemPart.make("Prefer short titles."))
        event.messages = [Message.user("[redacted]")]
        Object.assign(event.options, { maxTokens: 32, maxCompletionTokens: 128, reasoningEffort: "low" })
      }
      if (kind === "smaller") event.options.maxTokens = 12
      if (kind === "result") event.result = "Plug"
    }))
    if (kind === "codex") yield* f.hooks.register("session", "model.request", (event) =>
      Effect.sync(() => { event.baseURL = "https://chatgpt.com/backend-api/codex" }))
    yield* f.run
    expect(contexts).toBe(0)
    expect((yield* f.get)?.title).toBe(`${stamp}-${kind === "result" ? "Plug" : "Tree"}`)
    if (kind === "result") { expect(requests.length).toBe(0); return }
    const text = requestText()
    if (kind === "redact") {
      expect(text).toBe("[redacted]")
      expect(JSON.stringify(requests[0]!.messages)).not.toContain("Redact this message")
      expect(requests[0]!.providerOptions).toEqual({ maxCompletionTokens: 20, reasoningEffort: "low" })
    }
    expect(requests[0]!.maxTokens).toBe(kind === "smaller" ? 12 : kind === "codex" ? undefined : 20)
    if (kind === "codex") expect(requests[0]!.model.route.endpoint.baseURL).toBe("https://chatgpt.com/backend-api/codex")
  }))
}

const modelCases: { name: string; small?: Model.Info; variants?: string[]; variant?: string; fail?: boolean;
  models: string[]; attempted: string[]; smallSelection?: string }[] = [
  { name: "uses a small model from the primary provider", small, models: ["title-small"], attempted: ["none"], smallSelection: "none" },
  { name: "falls back to the primary model when the small model fails", small: lowSmall, variant: "high",
    fail: true, models: ["title-small", "title-model"], attempted: ["low", "high"] },
  { name: "uses the primary model at its lowest variant without a small model", variants: ["none", "low", "high"],
    variant: "high", models: ["title-model"], attempted: ["none"] },
  { name: "falls back to the selected primary variant when the lowest variant fails", variants: ["low", "high"],
    variant: "high", fail: true, models: ["title-model", "title-model"], attempted: ["low", "high"] },
  { name: "uses the selected primary variant when no lower variant exists", variants: ["high", "max"],
    variant: "high", models: ["title-model"], attempted: ["high"] },
  { name: "keeps the primary default variant instead of a low variant that may enable reasoning", variants: ["low", "high"],
    models: ["title-model"], attempted: ["default"] },
  { name: "uses the primary none variant from its default variant", variants: ["none", "low", "high"],
    models: ["title-model"], attempted: ["none"] },
]
for (const scenario of modelCases) it.effect(scenario.name, () => Effect.gen(function* () {
  selectedSmall = scenario.small
  if (scenario.variants) selectedPrimary = Model.Info.make({
    ...Model.Info.default(Provider.ID.make("test"), Model.ID.make("title-model")),
    variants: scenario.variants.map((id) => ({ id: Model.VariantID.make(id) })),
  })
  const f = yield* start({ variant: scenario.variant })
  const attempts: string[] = []
  yield* f.hooks.register("session", "model.request", (event) =>
    Effect.sync(() => { attempts.push(String(event.model.variant)) }))
  if (scenario.fail) titleStream = () => requests.length === 1
    ? Stream.fail(providerRejected({ message: "Selected title model unavailable" })) : successfulTitle()
  yield* f.run
  expect(requests.map((request) => String(request.model.id))).toEqual(scenario.models)
  expect(attempts).toEqual(scenario.attempted)
  if (scenario.smallSelection) expect(selections[1]?.variant).toBe(Model.VariantID.make(scenario.smallSelection))
  expect((yield* f.get)?.title).toBe(`${stamp}-Tree`)
}))

for (const scenario of [
  { name: "retries a legacy persisted fallback title", title: "New session - 2026-07-30T18:45:03.662Z",
    created: Date.parse("2026-07-30T18:45:03.662Z"), child: false },
  { name: "generates a title for an explicitly requested child session", title: undefined, created, child: true },
]) it.effect(scenario.name, () => Effect.gen(function* () {
  const f = yield* start(scenario)
  yield* f.run
  expect(requests.length).toBe(1)
  const date = new Date(scenario.created)
  const pad = (n: number) => String(n).padStart(2, "0")
  const expected = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
  expect((yield* f.get)?.title).toBe(`${expected}-Tree`)
  expect(!!(yield* f.get)?.parentID).toBe(scenario.child)
}))

for (const scenario of [
  { name: "keeps a date even when the title agent is removed", first: "Help me debug the failing build" },
  { name: "dates an empty session before any user message or model request", first: null },
]) it.effect(scenario.name, () => Effect.gen(function* () {
  const f = yield* start({ ...scenario, enabled: false })
  yield* f.run
  expect(requests.length).toBe(0)
  expect((yield* f.get)?.title).toBe(stamp)
}))

it.effect("regenerates an existing title using the title agent", () => Effect.gen(function* () {
  const f = yield* start({ title: "Original title", first: "Investigate the login failure" })
  const assistantMessageID = SessionMessage.ID.create()
  const identifiers = { sessionID: f.id, assistantMessageID }
  yield* f.bus.publish(SessionEvent.Step.Started, {
    ...identifiers, agent: Agent.ID.make("build"), model: primaryRef(), started: 0,
  })
  yield* f.bus.publish(SessionEvent.Reasoning.Started, { ...identifiers, ordinal: 0 })
  yield* f.bus.publish(SessionEvent.Reasoning.Ended, {
    ...identifiers, ordinal: 0, text: "Private reasoning that should not appear",
  })
  yield* f.bus.publish(SessionEvent.Text.Started, { ...identifiers, ordinal: 1 })
  yield* f.bus.publish(SessionEvent.Text.Ended, {
    ...identifiers, ordinal: 1, text: "The actual issue is expired OAuth credentials.",
  })
  yield* prompt(f.id, "Switch to fixing OAuth token refresh")
  yield* f.run
  const text = requestText()
  expect(text).toBe("Investigate the login failure")
  for (const omitted of ["The actual issue is expired OAuth credentials.", "Switch to fixing OAuth token refresh",
    "Private reasoning that should not appear"]) expect(JSON.stringify(requests[0]!.messages)).not.toContain(omitted)
  expect((yield* f.get)?.title).toBe(`${stamp}-Tree`)
}))

for (const scenario of [
  { name: "preserves the existing title when regeneration fails", initial: "Original title", retry: false, transport: false },
  { name: "retries after a failed title request", initial: undefined, retry: true, transport: false },
  { name: "retains the dated fallback after a failed title stream", initial: undefined, retry: false, transport: true },
]) it.effect(scenario.name, () => Effect.gen(function* () {
  const f = yield* start({ title: scenario.initial })
  const error = scenario.transport
    ? new AIError({ reason: new TransportError({ message: "Disconnected", transport: "http", operation: "request" }) })
    : providerRejected({ message: "Provider unavailable" })
  titleStream = () => Stream.fail(error)
  yield* f.run
  expect((yield* f.get)?.title).toBe(scenario.initial ?? stamp)
  if (scenario.retry) { titleStream = successfulTitle; yield* f.run }
  expect(requests.length).toBe(scenario.retry ? 2 : 1)
  expect((yield* f.get)?.title).toBe(scenario.retry ? `${stamp}-Tree` : scenario.initial ?? stamp)
}))

it.effect("preserves a manual rename completed while generation is in flight", () => Effect.gen(function* () {
  const f = yield* start()
  const started = yield* Deferred.make<void>()
  const release = yield* Deferred.make<void>()
  titleStream = () => Stream.unwrap(Effect.gen(function* () {
    yield* Deferred.succeed(started, undefined)
    yield* Deferred.await(release)
    return successfulTitle()
  }))
  const fiber = yield* f.run.pipe(Effect.forkScoped)
  yield* Deferred.await(started)
  yield* f.bus.publish(SessionEvent.Renamed, { sessionID: f.id, title: "Manual title" })
  yield* Deferred.succeed(release, undefined)
  yield* Fiber.join(fiber)
  expect(requests.length).toBe(1)
  expect((yield* f.get)?.title).toBe("Manual title")
}))
