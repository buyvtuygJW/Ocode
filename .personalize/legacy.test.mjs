import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import { randomUUID } from "node:crypto"

// Bun 1.4 does not export Node's stripTypeScriptTypes. Do not link that named
// export before selecting the runtime; Bun uses its own TypeScript transpiler.
const stripTypeScriptTypes = globalThis.Bun ? undefined : (await import("node:module")).stripTypeScriptTypes

// Execute the owned production bodies, not copies of their algorithms. Only the
// service boundary is replaced: no database, real config, network, or processes.
// The allowlist fails closed if a new runtime import is added to these modules.
const requireCore = createRequire(new URL("../packages/core/package.json", import.meta.url))
// Node ESM needs a file URL, not a Windows drive-letter path, for dynamic import.
const runtime = process.env.PERSONALIZE_EFFECT ?? pathToFileURL(requireCore.resolve("effect")).href
const { Context, Deferred, Effect, JsonSchema, Schema, Scope } = await import(runtime)
// Test the real HTTP request combinators too. Effect's audit dependency has the
// stable /http layout; the application pin uses /unstable/http. Root resolution
// (including an explicit PERSONALIZE_EFFECT override) remains unchanged/lazy.
const HttpClientRequest = await import(new URL("./unstable/http/HttpClientRequest.js", runtime).href).catch((error) => {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error
  return import(new URL("./http/HttpClientRequest.js", runtime).href)
})
const root = new URL("../", import.meta.url)
function load(relative, dependencies, names) {
  const file = new URL(relative, root)
  const original = readFileSync(file, "utf8")
  let source = globalThis.Bun
    ? new Bun.Transpiler({ loader: "ts" }).transformSync(original)
    : stripTypeScriptTypes(original)
  const imported = (specifier) => {
    assert.ok(Object.hasOwn(dependencies, specifier), `Unmocked import in ${relative}: ${specifier}`)
    return `dependencies[${JSON.stringify(specifier)}]`
  }
  const exported = new Map()
  source = source
    .replace(/^export \* as \w+ from [^\n]+\n/gm, "")
    .replace(/^export\s*\{([^}]*)\};?\s*$/gm, (_, clause) => {
      for (const item of clause.split(",").map((item) => item.trim()).filter(Boolean)) {
        const match = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(item)
        assert.ok(match, `Unhandled export in ${relative}: ${item}`)
        exported.set(match[2] ?? match[1], match[1])
      }
      return ""
    })
    .replace(/^import \{([^}]+)\} from ["']([^"']+)["'];?\s*$/gm, (_, names, specifier) =>
      `const {${names.replace(/\bas\b/g, ":")}} = ${imported(specifier)};`)
    .replace(/^import (\w+) from ["']([^"']+)["'];?\s*$/gm, (_, name, specifier) =>
      `const ${name} = ${imported(specifier)};`)
    .replace(/^export /gm, "")
  assert.doesNotMatch(source, /^import\s/m, `Unhandled import in ${relative}`)
  const denyNetwork = () => { throw new Error("Network forbidden in legacy regression tests") }
  const result = names.map((name) => `${name}: ${exported.get(name) ?? name}`).join(",")
  return new Function("dependencies", "fetch", `${source}\nreturn {${result}}`)(dependencies, denyNetwork)
}

const { define } = load("packages/plugin/src/effect/plugin.ts", {}, ["define"])
const Tool = load("packages/schema/src/tool.ts", { effect: { Effect, JsonSchema, Schema } }, ["Error", "TextContent"])
const tag = (name) => ({ Service: Context.Service()(`LegacyTest/${name}`) })
const Global = tag("Global"), FSUtil = tag("FSUtil"), Session = tag("Session"), Model = tag("Model")
const MemberModels = tag("MemberModels"), MemberClient = tag("MemberClient")
const modelNode = { name: "fixture-model-resolver" }
const localLogs = []
const outputPolicy = load("packages/core/src/personalize/output-policy.ts", {}, ["capBody", "outputCap", "outputEffort"])
const outputRequest = load("packages/core/src/personalize/output-request.ts", {
  "./output-policy": outputPolicy,
}, ["capRequest"])
class LanguageModel {
  constructor(input) { Object.assign(this, input) }
  static input(model) { return { ...model } }
}
const Message = { user: (text) => ({ role: "user", content: [{ type: "text", text }] }) }
const identity = { ID: { make: (id) => id } }
const legacy = load("packages/core/src/plugin/personalize.ts", {
  path,
  effect: { Effect: { ...Effect, logInfo: (...args) => Effect.sync(() => { localLogs.push(args) }) } },
  "node:crypto": { randomUUID },
  "@opencode/ai/effect": { LanguageModel, Message, LLMClient: MemberClient },
  "effect/unstable/http": { HttpClientRequest },
  "@opencode/plugin/effect/plugin": { define },
  "@opencode/schema/tool": { Tool },
  "@opencode/schema/model": { Model: identity },
  "@opencode/schema/provider": { Provider: identity },
  "@opencode/util/global": { Global },
  "@opencode/util/fs-util": { FSUtil },
  "../model.js": { Model },
  "../session.js": { Session },
  "../model-resolver.js": { Service: MemberModels.Service },
  "../personalize/output-request": outputRequest,
}, ["Plugin", "captureTrajectory", "scoreTrajectory", "normalizeCadence", "cronMatches", "nextRun", "isDue", "councilMemberOptions", "councilMemberWire", "councilTraceOrigin"])
const { Plugin } = legacy
const resolverDependencies = {
  "../model-resolver.js": { ModelResolver: { ...MemberModels, node: modelNode } },
  "@opencode/util/effect/layer-node": { LayerNode: { group: (nodes) => ({ nodes }) } },
}
const { decorate } = load("packages/core/src/personalize/tools.ts", {
  effect: { Context, Effect, Scope }, "../plugin/personalize": { Plugin },
  ...resolverDependencies,
}, ["decorate"])

const provider = "test-provider"
const members = ["test-provider/one", "test-provider/two"]
const project = path.resolve("virtual-project"), global = path.resolve("virtual-global")
const globalCouncil = path.join(global, "council.json")
const projectCouncil = path.join(project, ".opencode", "council.json")
const scheduleFile = path.join(global, "scheduled_tasks.json")
const context = { sessionID: "parent-session", id: "call-1", agent: "build", messageID: "message-1" }
const output = (result) => {
  assert.equal(result.content.length, 1)
  assert.equal(Schema.is(Tool.TextContent)(result.content[0]), true)
  return result.content[0].text
}
const noCalls = (h) => {
  assert.equal(h.created.length, 0)
  assert.equal(h.generated.length, 0)
}

async function harness(options = {}) {
  const tools = new Map(), commands = new Map(), files = new Map(options.files ?? [])
  const reads = [], writes = [], created = [], generated = [], memberRequests = [], stockRequests = [], prompts = [], transforms = []
  const available = (options.available ?? ["one", "two", "three"]).map((id) => ({ providerID: provider, id }))
  const fs = {
    readJson: (file) => Effect.sync(() => { reads.push(file); return files.get(file) }),
    makeDirectory: () => Effect.void,
    ensureDir: () => Effect.void,
    writeJson: (file, value) => Effect.suspend(() => {
      if (options.failWrite) return Effect.fail(new Error("disk denied"))
      writes.push([file, structuredClone(value)])
      files.set(file, structuredClone(value))
      return Effect.void
    }),
    writeFileString: (file, value) => Effect.suspend(() => {
      if (options.failWrite) return Effect.fail(new Error("disk denied"))
      writes.push([file, value]); files.set(file, value)
      return Effect.void
    }),
  }
  const sessions = {
    get: (id) => options.failGet
      ? Effect.fail(new Error("session missing"))
      : Effect.succeed({ id, title: "Fixture session", model: { providerID: provider, id: "one" } }),
    messages: (input) => Effect.suspend(() => {
      assert.deepEqual(input, { sessionID: context.sessionID })
      return options.failMessages ? Effect.fail(new Error("history missing")) : Effect.succeed(options.messages ?? [])
    }),
    model: () => Effect.succeed({ providerID: provider, id: "one" }),
    create: (input) => Effect.suspend(() => {
      if (options.failCreate) return Effect.fail(new Error("creation denied"))
      created.push(input)
      return Effect.succeed({ id: `child-${created.length}` })
    }),
    generate: (input) => Effect.suspend(() => {
      stockRequests.push(input)
      generated.push(input)
      return options.generate?.(input, generated.length) ?? Effect.succeed(`answer-${generated.length}`)
    }),
  }
  const memberModels = {
    resolve: (ref) => options.failResolve ? Effect.fail(new Error("resolution denied")) : Effect.succeed({
      ref,
      model: new LanguageModel({ id: ref.id, providerID: ref.providerID, options: options.memberOptions ?? { maxTokens: 2400 },
        route: { options: options.routeOptions ?? {}, auth: { type: "fixture-auth" } } }),
      limit: { context: 100000, output: 50000 },
    }),
  }
  const memberClient = {
    generate: (request, transport) => Effect.suspend(() => {
      memberRequests.push({ request, transport })
      const input = { prompt: request.messages[0].content[0].text, model: request.model }
      generated.push(input)
      const result = options.memberGenerate?.(request, memberRequests.length) ?? options.generate?.(input, generated.length) ?? Effect.succeed(`answer-${generated.length}`)
      return result.pipe(Effect.map((value) => typeof value === "string" ? { text: value, finishReason: { normalized: "stop" } } : value))
    }),
  }
  const host = {
    location: { directory: project },
    tool: { transform: (register) => Effect.sync(() => {
      transforms.push("tool")
      assert.equal(register({ add: (tool) => {
        assert.ok(!tools.has(tool.name), `Duplicate tool: ${tool.name}`)
        tools.set(tool.name, tool)
      } }), undefined, "registration callback is synchronous and returns void")
    }) },
    command: { transform: (register) => Effect.sync(() => {
      transforms.push("command")
      assert.equal(register({ add: (command) => {
        assert.ok(!commands.has(command.name))
        commands.set(command.name, command)
      } }), undefined)
    }) },
    session: { prompt: (input) => Effect.sync(() => { prompts.push(input) }) },
  }
  const provide = (effect) => effect.pipe(
    Effect.provideService(Global.Service, { config: global }),
    Effect.provideService(FSUtil.Service, fs),
    Effect.provideService(Session.Service, sessions),
    Effect.provideService(Model.Service, { available: () => Effect.succeed(available) }),
    Effect.provideService(MemberModels.Service, memberModels),
    Effect.provideService(MemberClient.Service, memberClient),
  )
  await Effect.runPromise(provide(Plugin.effect(host)))
  return {
    tools, commands, files, reads, writes, created, generated, memberRequests, stockRequests, prompts, transforms, host, provide,
    call: (name, input) => Effect.runPromise(provide(tools.get(name).execute(input, context))),
  }
}

test("default Effect resolution produces a Node-compatible file URL", {
  skip: process.env.PERSONALIZE_EFFECT !== undefined ? "Explicit Effect override selected" : false,
}, () => {
  assert.equal(new URL(runtime).protocol, "file:")
  assert.equal(runtime, pathToFileURL(requireCore.resolve("effect")).href)
})

test("legacy activation registers exactly three tools and three commands without side effects", async () => {
  const h = await harness()
  assert.deepEqual([...h.tools.keys()].sort(), ["council", "distill_session", "schedule_task"])
  assert.deepEqual([...h.commands.keys()].sort(), ["council", "distill", "schedule"])
  assert.deepEqual(h.transforms, ["tool", "command"])
  assert.equal(h.reads.length + h.writes.length + h.prompts.length, 0)
  noCalls(h)
})

test("legacy tools expose root JSON schemas, never the obsolete nested properties shape", async () => {
  const h = await harness()
  for (const [name, tool] of h.tools) {
    assert.equal(tool.input.type, "object", name)
    assert.equal(tool.input.additionalProperties, false, name)
    assert.ok(tool.input.properties)
    assert.equal(tool.input.properties.type, undefined)
    assert.equal(tool.options.codemode, false)
    assert.ok(tool.description.length > 0)
  }
  assert.deepEqual(h.tools.get("council").input.required, ["question"])
  assert.deepEqual(h.tools.get("schedule_task").input.required, ["action"])
  assert.equal(h.tools.get("distill_session").input.required, undefined)
  assert.deepEqual(h.tools.get("council").input.properties.members.items, { type: "string" })
  assert.equal(h.tools.get("council").input.properties.rounds.type, "number")
})

for (const name of ["council", "distill", "schedule"]) {
  test(`/${name} forwards every prompt field and the invocation session without mutating input`, async () => {
    const h = await harness()
    const extension = { future: true }
    const prompt = { text: "some arguments", agent: "plan", model: { id: "two", providerID: provider },
      files: [{ url: "file:///virtual/input.txt" }], variant: "low", extension }
    const before = structuredClone(prompt)
    await Effect.runPromise(h.commands.get(name).execute({ sessionID: context.sessionID, prompt, delivery: {} }))
    assert.equal(h.prompts.length, 1)
    const sent = h.prompts[0]
    assert.equal(sent.sessionID, context.sessionID)
    for (const [key, value] of Object.entries(prompt)) if (key !== "text") assert.equal(sent[key], value)
    assert.ok(sent.text.includes(prompt.text))
    assert.deepEqual(prompt, before)
    noCalls(h)
    assert.equal(h.writes.length, 0)
  })
  test(`/${name} treats dollar replacement tokens as literal user arguments`, async () => {
    const h = await harness()
    const text = "$& $$ $` $' $ARGUMENTS"
    await Effect.runPromise(h.commands.get(name).execute({ sessionID: context.sessionID, prompt: { text }, delivery: {} }))
    assert.ok(h.prompts[0].text.includes(text), "replacement syntax must not reinterpret command arguments")
  })
}

test("slash commands accept omitted text without injecting undefined", async () => {
  const h = await harness()
  await Effect.runPromise(h.commands.get("council").execute({ sessionID: context.sessionID, prompt: {}, delivery: {} }))
  assert.doesNotMatch(h.prompts[0].text, /undefined|\$ARGUMENTS/)
})

for (const [strategy, count] of [["council", 3], ["compare", 2], ["consensus", 4], ["moa", 3], ["debate", 5], ["router", 2], ["arena", 2]]) {
  test(`council ${strategy} keeps its ${count}-call nominal plan across owned members and stock chair`, async () => {
    const h = await harness()
    const result = output(await h.call("council", { question: "Which fix?", members, strategy }))
    assert.ok(result.length > 0)
    assert.equal(h.generated.length, count)
    const chairCalls = ["council", "moa", "debate", "router"].includes(strategy) ? 1 : 0
    assert.equal(h.created.length, count - chairCalls)
    h.created.forEach((input, index) => {
      assert.equal(input.parentID, context.sessionID)
      assert.equal(input.model.providerID, provider)
      assert.ok(["one", "two"].includes(input.model.id))
      assert.equal(input.title, "Council member")
      assert.ok(h.memberRequests[index].request.messages[0].content[0].text.includes("Which fix?"))
    })
    if (["council", "moa", "debate"].includes(strategy)) {
      const chair = h.generated.find((call) => call.sessionID === context.sessionID)
      assert.ok(chair, "chairman uses the invoking session, not a new member child")
      assert.equal(chair.model, undefined)
      assert.match(h.generated.at(-1).prompt, /answer-/)
    }
    assert.equal(h.writes.length, 0)
  })
}

for (const [alias, count] of [["synth", 3], ["sidebyside", 2], ["vote", 4], ["roundtable", 5], ["map", 3], ["route", 2]]) {
  test(`council legacy alias ${alias} keeps its intended strategy`, async () => {
    const h = await harness()
    await h.call("council", { question: "Q", members, strategy: alias })
    assert.equal(h.generated.length, count)
  })
}

test("compare labels duplicate member refs separately and preserves configured order", async () => {
  const h = await harness()
  const result = output(await h.call("council", { question: "Q", members: [members[1], members[0], members[1]], strategy: "compare" }))
  assert.deepEqual(h.created.map((entry) => entry.model.id), ["two", "one", "two"])
  assert.ok(result.indexOf("member1") < result.indexOf("member2"))
  assert.ok(result.indexOf("member2") < result.indexOf("member3"))
  assert.equal(h.generated.length, 3)
})

test("debate includes previous answers while compare keeps member prompts independent", async () => {
  for (const strategy of ["debate", "compare"]) {
    const h = await harness()
    await h.call("council", { question: "Q", members, strategy })
    assert.equal(h.generated[strategy === "debate" ? 2 : 1].prompt.includes("answer-1"), strategy === "debate")
  }
})

test("council member failure is labelled once, with no automatic generation retry", async () => {
  const h = await harness({ generate: (_, index) => index === 2 ? Effect.fail(new Error("member failed")) : Effect.succeed(`answer-${index}`) })
  const result = output(await h.call("council", { question: "Q", members }))
  assert.equal(h.generated.length, 3)
  assert.match(h.generated[2].prompt, /failed:.*member failed/)
  assert.match(result, /answer-3/)
})

test("chairman failure remains an actionable tool error and is not retried", async () => {
  const h = await harness({ generate: (_, index) => index === 3 ? Effect.fail(new Error("chair failed")) : Effect.succeed("answer") })
  await assert.rejects(h.call("council", { question: "Q", members }), /Chairman generation failed.*chair failed/)
  assert.equal(h.generated.length, 3)
})

for (const input of [{ question: " " },
  { question: "Q", members: ["bad-ref"] }, { question: "Q", members: ["/model"] },
  { question: "Q", members: ["provider/"] }, { question: "Q", members: ["test-provider/missing"] }]) {
  test(`council rejects invalid request before creating sessions: ${JSON.stringify(input)}`, async () => {
    const h = await harness()
    await assert.rejects(h.call("council", input), /requires|Invalid member|at least two valid members/)
    noCalls(h)
  })
}

test("project council config wins over global and inline members win over both", async () => {
  for (const inline of [undefined, [members[0], `${provider}/three`]]) {
    const h = await harness({ files: [
      [projectCouncil, { members: [{ name: "project1", model: members[1] }, { name: "project2", model: members[0] }] }],
      [globalCouncil, { members: [{ name: "global1", model: `${provider}/three` }, { name: "global2", model: members[0] }] }],
    ] })
    await h.call("council", { question: "Q", strategy: "compare", members: inline })
    assert.deepEqual(h.created.map((entry) => entry.model.id), inline ? ["one", "three"] : ["two", "one"])
    assert.deepEqual(h.reads, inline ? [] : [projectCouncil])
  }
})

test("missing council config seeds a template, never silently chooses or calls a model", async () => {
  const h = await harness()
  assert.match(output(await h.call("council", { question: "Q" })), /No council configured.*seeded/i)
  noCalls(h)
  assert.equal(h.writes.length, 1)
  assert.equal(h.writes[0][0], globalCouncil)
  assert.equal(h.writes[0][1].members[0].model, members[0], "seeding copies the invoking session model but never calls it")
})

test("schedule add/list/export/remove uses only in-memory storage and preserves updates", async () => {
  const h = await harness()
  assert.match(output(await h.call("schedule_task", { action: "add", name: "review", cadence: "@daily", prompt: "review files" })), /Recorded schedule/)
  const first = h.files.get(scheduleFile).tasks[0]
  assert.equal(first.cadence, "0 9 * * *", "legacy @daily remains 09:00 local time")
  assert.equal(first.prompt, "review files")
  assert.ok(Number.isFinite(Date.parse(first.created)))
  assert.match(output(await h.call("schedule_task", { action: "list" })), /review/)
  const exported = JSON.parse(output(await h.call("schedule_task", { action: "export" })))
  assert.deepEqual(exported, { path: scheduleFile, tasks: [first] })
  await h.call("schedule_task", { action: "add", name: "review", cadence: "@hourly", prompt: "updated" })
  assert.equal(h.files.get(scheduleFile).tasks.length, 1)
  assert.equal(h.files.get(scheduleFile).tasks[0].prompt, "updated")
  assert.match(output(await h.call("schedule_task", { action: "remove", name: "review" })), /Removed "review"/)
  assert.match(output(await h.call("schedule_task", { action: "list" })), /No schedules/)
  noCalls(h)
})

for (const input of [{ action: "add" }, { action: "add", name: "n", cadence: "garbage", prompt: "p" }, { action: "remove" }]) {
  test(`invalid schedule does not write or generate: ${JSON.stringify(input)}`, async () => {
    const h = await harness()
    await assert.rejects(h.call("schedule_task", input), /requires|Unparseable/)
    assert.equal(h.writes.length, 0)
    noCalls(h)
  })
}

test("schedule write failure surfaces as Tool.Error instead of pretending success", async () => {
  const h = await harness({ failWrite: true })
  await assert.rejects(h.call("schedule_task", { action: "add", name: "n", cadence: "@daily", prompt: "p" }), /Cannot write.*disk denied/)
  assert.equal(h.writes.length, 0)
  noCalls(h)
})

test("scheduler normalizes aliases and evaluates next runs against a fixed local clock", () => {
  assert.equal(legacy.normalizeCadence("@daily"), "0 9 * * *")
  assert.equal(legacy.normalizeCadence("every 15 minutes"), "*/15 * * * *")
  assert.equal(legacy.normalizeCadence("every 2 hours"), "0 */2 * * *")
  assert.equal(legacy.normalizeCadence("not a cadence"), undefined)
  const clock = new Date(2026, 0, 5, 12, 0, 40)
  const next = legacy.nextRun("*/15 * * * *", clock)
  assert.equal(next.toISOString(), new Date(2026, 0, 5, 12, 15).toISOString())
  const entry = { cadence: "*/15 * * * *", created: clock.toISOString() }
  assert.equal(legacy.isDue(entry, new Date(next.getTime() - 1)), false)
  assert.equal(legacy.isDue(entry, next), true)
})

const successfulHistory = [
  { type: "user", text: "Implement and verify the change" },
  { type: "assistant", content: ["read", "patch", "shell", "grep", "glob"].map((name) => ({ type: "tool", name, state: { status: "completed" } })) },
  { type: "idle", outcome: "completed" },
]
test("distill preview scores the actual trajectory without generation or writes", async () => {
  const h = await harness({ messages: successfulHistory })
  assert.match(output(await h.call("distill_session", { action: "preview" })), /RSI score: 100\/100/)
  noCalls(h)
  assert.equal(h.writes.length, 0)
})

test("distill below threshold does not generate, write, or treat an idle failure as success", async () => {
  const h = await harness({ messages: [{ type: "idle", outcome: "failed" }, { type: "idle", outcome: "failed" }, { type: "idle", outcome: "interrupted" }] })
  assert.match(output(await h.call("distill_session", {})), /below threshold/)
  noCalls(h)
  assert.equal(h.writes.length, 0)
})

for (const useProject of [false, true]) {
  test(`distill successful run generates once and writes a sanitized ${useProject ? "project" : "global"} skill path`, async () => {
    const h = await harness({ messages: successfulHistory })
    assert.match(output(await h.call("distill_session", { action: "run", project: useProject, name: "../../Unsafe Name!" })), /Saved learned skill/)
    assert.equal(h.generated.length, 1)
    assert.equal(h.generated[0].sessionID, context.sessionID)
    assert.equal(h.created.length, 0)
    assert.equal(h.writes.length, 1)
    assert.equal(h.writes[0][0], path.join(useProject ? path.join(project, ".opencode") : global, "skills", "unsafe-name", "SKILL.md"))
    assert.match(h.writes[0][1], /^---\nname: unsafe-name\n/)
    assert.match(h.writes[0][1], /answer-1/)
  })
}

test("distill generation failure does not save a partial skill or retry", async () => {
  const h = await harness({ messages: successfulHistory, generate: () => Effect.fail(new Error("generation denied")) })
  await assert.rejects(h.call("distill_session", {}), /Skill generation failed.*generation denied/)
  assert.equal(h.generated.length, 1)
  assert.equal(h.writes.length, 0)
})

test("distill history failure remains an actionable tool error", async () => {
  const h = await harness({ failMessages: true })
  await assert.rejects(h.call("distill_session", { action: "preview" }), /Cannot read session.*history missing/)
  noCalls(h)
  assert.equal(h.writes.length, 0)
})

test("trajectory capture counts real idle outcomes and tool states, with sorted distinct tools", () => {
  const stats = legacy.captureTrajectory([...successfulHistory,
    { type: "assistant", content: [{ type: "text", text: "done" }, { type: "tool", name: "read", state: { status: "error" } }] },
    { type: "idle", outcome: "failed" }, { type: "idle", outcome: "interrupted" },
  ])
  assert.deepEqual(stats, { userTurns: 1, assistantTurns: 2, toolCalls: 6, toolErrors: 1,
    distinctTools: ["glob", "grep", "patch", "read", "shell"], failedIdles: 1, interrupted: 1,
    firstUserText: "Implement and verify the change" })
  const score = legacy.scoreTrajectory(stats)
  assert.equal(score.correctness, 67)
  assert.equal(score.reproducibility, 60)
  assert.equal(score.total, 79)
})

test("legacy plugin list wrapper forwards stock arguments and leaves stock collections untouched", async () => {
  const h = await harness()
  const original = { pre: [{ id: "pre" }], post: [{ id: "post" }], builtin: [{ id: "builtin" }], extension: {} }
  const argumentsSeen = []
  const stock = { list: (...args) => Effect.sync(() => { argumentsSeen.push(args); return original }) }
  const args = [{ future: true }, Symbol("tail")]
  const result = await Effect.runPromise(h.provide(decorate(stock).list(...args)))
  assert.equal(argumentsSeen.length, 1)
  assert.deepEqual(argumentsSeen[0], args)
  assert.equal(result.pre, original.pre)
  assert.equal(result.builtin, original.builtin)
  assert.equal(result.extension, original.extension)
  assert.notEqual(result.post, original.post)
  assert.equal(original.post.length, 1)
  assert.equal(result.post.length, 2)
  assert.equal(result.post.at(-1).id, Plugin.id)
  assert.equal(result.post.at(-1).revision, "internal")
  assert.deepEqual(result.post.at(-1).source, { type: "builtin" })
})

test("legacy list wrapper propagates stock failure without activating a plugin or retrying", async () => {
  let calls = 0
  const failure = new Error("stock list failed")
  const stock = { list: () => { calls += 1; return Effect.fail(failure) } }
  await assert.rejects(Effect.runPromise(decorate(stock).list()), /stock list failed/)
  assert.equal(calls, 1)
})

test("unknown council strategies keep the documented council fallback", async () => {
  const h = await harness()
  await h.call("council", { question: "Q", members, strategy: "unknown-legacy-alias" })
  assert.equal(h.generated.length, 3)
  assert.equal(h.created.length, 2)
})

test("compare fans out concurrently but keeps member result order", { timeout: 5000 }, async () => {
  const bothStarted = await Effect.runPromise(Deferred.make())
  const h = await harness({ generate: (_, index) => index === 1
    ? Deferred.await(bothStarted).pipe(Effect.as("first-member-answer"))
    : Deferred.succeed(bothStarted, undefined).pipe(Effect.as("second-member-answer")) })
  const result = output(await h.call("council", { question: "Q", members, strategy: "compare" }))
  assert.equal(h.generated.length, 2)
  assert.ok(result.indexOf("first-member-answer") < result.indexOf("second-member-answer"))
})

test("legacy registration does not require or capture the activation scope", async () => {
  const scopedPlugin = { id: "personalize", effect: () => Effect.scope }
  const { decorate } = load("packages/core/src/personalize/tools.ts", {
    effect: { Context, Effect, Scope }, "../plugin/personalize": { Plugin: scopedPlugin },
    ...resolverDependencies,
  }, ["decorate"])
  const provide = (effect) => Effect.provideService(effect, MemberModels.Service, {})
  const stock = { list: () => Effect.succeed({ pre: [], post: [] }) }
  assert.equal((await Effect.runPromise(provide(decorate(stock).list()))).post.length, 1)
  let registrationScope
  const listed = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    registrationScope = yield* Effect.scope
    return yield* provide(decorate(stock).list())
  })))
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const hostScope = yield* Effect.scope
    assert.notEqual(hostScope, registrationScope)
    assert.equal(yield* listed.post[0].effect({}), hostScope)
  })))
})

test("owned member retry discards length-limited text, reuses the original request and never raises its cap", async () => {
  const attempts = new Map()
  const h = await harness({ memberGenerate: (request) => {
    const n = (attempts.get(request.model.id) ?? 0) + 1
    attempts.set(request.model.id, n)
    return Effect.succeed({ text: n === 1 ? "PARTIAL-DO-NOT-CARRY" : "complete", finishReason: { normalized: n === 1 ? "length" : "stop" } })
  } })
  const result = output(await h.call("council", { question: "original question", members, strategy: "compare" }))
  assert.equal(h.stockRequests.length, 0)
  assert.equal(h.memberRequests.length, 4)
  assert.doesNotMatch(result, /PARTIAL-DO-NOT-CARRY/)
  for (const id of ["one", "two"]) {
    const requests = h.memberRequests.filter((entry) => entry.request.model.id === id).map((entry) => entry.request)
    assert.equal(requests.length, 2)
    assert.equal(requests[0], requests[1])
    assert.equal(requests[0].maxTokens, 2400)
    assert.equal(requests[0].messages.length, 1)
    assert.equal(requests[0].messages[0].content[0].text, "original question")
    assert.doesNotMatch(JSON.stringify(requests[1]), /PARTIAL-DO-NOT-CARRY|parent-session|child-/)
  }
})

test("two length responses fail each member without returning a partial or attempting a third call", async () => {
  const h = await harness({ memberGenerate: () => Effect.succeed({ text: "PARTIAL-ONLY", finishReason: { normalized: "length" } }) })
  const result = output(await h.call("council", { question: "Q", members, strategy: "compare" }))
  assert.equal(h.memberRequests.length, 4)
  assert.equal(h.stockRequests.length, 0)
  assert.match(result, /length-limited twice/)
  assert.doesNotMatch(result, /PARTIAL-ONLY/)
})

test("member provider errors and errors after the length retry are not retried", async () => {
  for (const lengthFirst of [false, true]) {
    const attempts = new Map()
    const h = await harness({ memberGenerate: (request) => {
      const n = (attempts.get(request.model.id) ?? 0) + 1
      attempts.set(request.model.id, n)
      return lengthFirst && n === 1 ? Effect.succeed({ text: "partial", finishReason: { normalized: "length" } }) : Effect.fail(new Error("provider failed"))
    } })
    assert.match(output(await h.call("council", { question: "Q", members, strategy: "compare" })), /provider failed/)
    assert.equal(h.memberRequests.length, lengthFirst ? 4 : 2)
    assert.equal(h.stockRequests.length, 0)
  }
})

test("owned member defaults/overrides lose identifiers, preserve auth and do not mutate shared model settings", async () => {
  const settings = {
    maxTokens: 1234, promptCacheKey: "session-cache",
    headers: { Authorization: "Bearer fixture", "chatgpt-account-id": "account-fixture", "x-api-key": "api-fixture", "x-opencode-session": "session-header", "x-pxpipe-debug": "1", "x-pxpipe-local-session": "local-header" },
    providerOptions: { openai: { user: "local-user", safety_identifier: "local-safety", promptCacheKey: "local-cache", metadata: { sessionID: "local-meta" }, reasoningEffort: "high" }, scalar: "kept" },
    http: { body: { session_id: "local-session", previous_response_id: "local-response", metadata: { id: "local-meta" }, max_output_tokens: 1200 } },
  }
  const before = structuredClone(settings)
  const h = await harness({ memberOptions: settings, routeOptions: { promptCacheKey: "route-cache" } })
  await h.call("council", { question: "sensitive question", members, strategy: "compare" })
  assert.deepEqual(settings, before)
  assert.ok(h.created.every((entry) => entry.title === "Council member"))
  for (const { request } of h.memberRequests) {
    assert.equal(request.maxTokens, 1234)
    assert.equal(request.headers.Authorization, "Bearer fixture")
    assert.equal(request.headers["chatgpt-account-id"], "account-fixture")
    assert.equal(request.headers["x-api-key"], "api-fixture")
    assert.equal(request.providerOptions.openai.reasoningEffort, "high")
    assert.equal(request.http.body.max_output_tokens, 1200)
    assert.doesNotMatch(JSON.stringify({ ...request, messages: [], model: { options: request.model.options } }), /local-|session-cache|session-header|route-cache|x-pxpipe|x-opencode/)
    assert.deepEqual(request.model.route.auth, { type: "fixture-auth" })
  }
})

test("real HTTP request boundary strips late identifiers and debug headers but leaves auth and prompt JSON intact", () => {
  const content = { model: "fixture", session_id: "local", prompt_cache_key: "local", user: "local", metadata: { session: "local" }, previous_response_id: "local", messages: [{ role: "user", content: '{"user":"content-not-metadata"}' }] }
  const wire = HttpClientRequest.bodyUint8Array(HttpClientRequest.setHeaders(HttpClientRequest.post("https://provider.invalid/v1/responses"), {
    Authorization: "Bearer fixture", "x-api-key": "api-fixture", "chatgpt-account-id": "account-fixture", "x-opencode-session": "local", session_id: "local", "x-request-id": "local", traceparent: "local", "x-pxpipe-debug": "1", "x-pxpipe-local-session": "local", "content-length": "99999",
  }), new TextEncoder().encode(JSON.stringify(content)), "application/json")
  const clean = legacy.councilMemberWire(wire)
  assert.equal(clean.headers.authorization, "Bearer fixture")
  assert.equal(clean.headers["x-api-key"], "api-fixture")
  assert.equal(clean.headers["chatgpt-account-id"], "account-fixture")
  for (const key of ["x-opencode-session", "session_id", "x-request-id", "traceparent", "x-pxpipe-debug", "x-pxpipe-local-session", "content-length"]) assert.equal(clean.headers[key], undefined)
  assert.deepEqual(JSON.parse(new TextDecoder().decode(clean.body.body)), { model: "fixture", messages: content.messages })
  assert.equal(wire.headers["x-pxpipe-debug"], "1")
})

test("owned member actually installs the final HTTP scrubber, with tracing off by default", async () => {
  const h = await harness()
  await h.call("council", { question: "Q", members, strategy: "compare" })
  let forwarded
  await Effect.runPromise(h.memberRequests[0].transport.http(
    HttpClientRequest.setHeaders(HttpClientRequest.get("https://provider.invalid/v1/responses"), { Authorization: "Bearer fixture", "x-pxpipe-debug": "1", "x-pxpipe-local-session": "local", session_id: "local" }),
    (request) => Effect.sync(() => { forwarded = request }),
  ))
  assert.equal(forwarded.headers.authorization, "Bearer fixture")
  assert.equal(forwarded.headers["x-pxpipe-debug"], undefined)
  assert.equal(forwarded.headers["x-pxpipe-local-session"], undefined)
  assert.equal(forwarded.headers.session_id, undefined)
})

test("proxy-only tracing requires explicit loopback origin; remote, credentialled and malformed origins are rejected", () => {
  for (const value of [undefined, "", "1", "https://provider.invalid", "http://user:password@127.0.0.1:47821", "http://127.0.0.1:47821/path", "http://127.0.0.1:47821/?token=secret"]) assert.equal(legacy.councilTraceOrigin(value), undefined)
  assert.equal(legacy.councilTraceOrigin("http://127.0.0.1:47821/"), "http://127.0.0.1:47821")
  const trace = { origin: "http://127.0.0.1:47821", id: "12345678-1234-4123-8123-123456789abc" }
  const local = legacy.councilMemberWire(HttpClientRequest.get(`${trace.origin}/v1/responses`), trace)
  assert.equal(local.headers["x-pxpipe-debug"], "1")
  assert.equal(local.headers["x-pxpipe-local-session"], trace.id)
  for (const url of ["https://provider.invalid/v1/responses", "http://127.0.0.1:47822/v1/responses"]) {
    const remote = legacy.councilMemberWire(HttpClientRequest.get(url), { ...trace, origin: new URL(url).origin })
    assert.equal(remote.headers["x-pxpipe-debug"], new URL(url).hostname === "127.0.0.1" ? "1" : undefined)
    assert.equal(legacy.councilMemberWire(HttpClientRequest.get(url), trace).headers["x-pxpipe-local-session"], undefined)
  }
})

test("opt-in correlation is logged locally before generation and never uses the real local session id as a header", async () => {
  const previous = process.env.OPENCODE_COUNCIL_PROXY_TRACE_ORIGIN
  const start = localLogs.length
  process.env.OPENCODE_COUNCIL_PROXY_TRACE_ORIGIN = "http://127.0.0.1:47821"
  try {
    const h = await harness({ memberGenerate: () => {
      assert.ok(localLogs.length > start)
      return Effect.succeed("done")
    } })
    await h.call("council", { question: "Q", members, strategy: "compare" })
    const records = localLogs.slice(start)
    assert.equal(records.length, 2)
    for (let i = 0; i < records.length; i++) {
      const [, mapping] = records[i]
      assert.equal(mapping.parentID, context.sessionID)
      assert.equal(mapping.sessionID, `child-${i + 1}`)
      let forwarded
      await Effect.runPromise(h.memberRequests[i].transport.http(HttpClientRequest.get("http://127.0.0.1:47821/v1/responses"), (request) => Effect.sync(() => { forwarded = request })))
      assert.equal(forwarded.headers["x-pxpipe-local-session"], mapping.traceID)
      assert.doesNotMatch(mapping.traceID, /child-|parent-session/)
    }
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_COUNCIL_PROXY_TRACE_ORIGIN
    else process.env.OPENCODE_COUNCIL_PROXY_TRACE_ORIGIN = previous
  }
})

test("registration graph exposes the shared resolver needed by owned members", () => {
  const requirements = { name: "stock-requirements" }
  assert.deepEqual(decorate({ requirements }).requirements.nodes, [requirements, modelNode])
})

test("R facade exports the shared member resolver requirements as well as list", () => {
  const manifest = JSON.parse(readFileSync(new URL(".personalize/R.json", root), "utf8"))
  const entry = manifest.modules.find((item) => item.target === "packages/core/src/plugin/internal.ts")
  assert.equal(entry.factory, "packages/core/src/personalize/tools.ts")
  assert.deepEqual(entry.exports, ["list", "requirements"])
})

test.todo("supported proxy route restores a missing cap after OpenAI hooks; requires the pending route-aware fix, not these host doubles")
test.todo("live binary serialization and upstream billing require separately authorized, bounded evidence")
