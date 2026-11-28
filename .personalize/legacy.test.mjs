import assert from "node:assert/strict"
import { readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { writeFile as realWriteFile, readFile as realReadFile, mkdir } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
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
const { Context, Cron, DateTime, Deferred, Effect, JsonSchema, Schema, Scope } = await import(runtime)
// Resolve the public subpath from the selected Effect package, exactly as the
// production import does. No alternate layout or mock may hide a missing module.
const requireEffect = createRequire(runtime)
const { HttpClientRequest } = await import(pathToFileURL(requireEffect.resolve("effect/http")).href)
const root = new URL("../", import.meta.url)
function load(relative, dependencies, names) {
  const file = new URL(relative, root)
  const original = readFileSync(file, "utf8")
  let source = globalThis.Bun
    ? new Bun.Transpiler({ loader: "ts" }).transformSync(original)
    : stripTypeScriptTypes(original)
  const imported = (specifier) => {
    if (specifier === "effect" || specifier.startsWith("effect/")) requireEffect.resolve(specifier)
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
const Instance = { ...tag("Instance"), node: { name: "fixture-instance" } }
const Database = { ...tag("Database"), node: { name: "fixture-database" } }
const SessionContext = tag("SessionContext"), Automation = tag("Automation")
const Permission = { invocation: ({ sessionID, agent, messageID, id }) => ({
  sessionID, agent, source: { type: "tool", messageID, id },
}) }
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
const Message = { user: (text) => ({ role: "user", content: [{ type: "text", text }] }), system: (text) => ({ role: "system", content: [{ type: "text", text }] }) }
const identity = { ID: { make: (id) => id } }
const Agents = tag("Agents"), Registry = tag("Registry")
let writeFile = realWriteFile
const legacy = load("packages/core/src/plugin/personalize.ts", {
  path,
  effect: { Cron, DateTime, Effect: { ...Effect, logInfo: (...args) => Effect.sync(() => { localLogs.push(args) }) } },
  "node:crypto": { randomUUID },
  "node:fs/promises": { writeFile: (...args) => writeFile(...args) },
  "@opencode/ai/effect": { LanguageModel, Message, LLMClient: MemberClient },
  "effect/http": { HttpClientRequest },
  "@opencode/plugin/effect/plugin": { define },
  "@opencode/schema/tool": { Tool },
  "@opencode/schema/model": { Model: identity },
  "@opencode/schema/provider": { Provider: identity },
  "@opencode/util/global": { Global },
  "@opencode/util/fs-util": { FSUtil },
  "../model.js": { Model },
  "../session.js": { Session },
  "../agent.js": { Agent: Agents },
  "../tool.js": { Service: Registry.Service },
  "../personalize/subagent-capabilities.js": { registerSubagentCapabilities() {} },
  "../automation.js": { Automation },
  "../permission.js": { Permission },
  "../instance/service.js": { Instance },
  "../database/database.js": { Database },
  "../session/context.js": { SessionContext },
  "../session/history.js": { SessionHistory: { preview: () => Effect.flatMap(SessionContext.Service, (ctx) => Effect.succeed(ctx.history)) } },
  "../session/model-request.js": { SessionModelRequest: { baseTranscript: (input) => ({ system: ["prepared-session-system"], messages: input.messages }) } },
  "../model-resolver.js": { Service: MemberModels.Service },
  "../personalize/output-request": outputRequest,
}, ["Plugin", "writeJsonSafe", "captureTrajectory", "scoreTrajectory", "normalizeCadence", "councilMemberOptions", "councilMemberWire", "councilTraceOrigin", "validateBallot", "validateRoute", "validateAnswer"])
const { Plugin } = legacy
const resolverDependencies = {
  "../model-resolver.js": { ModelResolver: { ...MemberModels, node: modelNode } },
  "../instance/service.js": { Instance },
  "../database/database.js": { Database },
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
  const reads = [], writes = [], created = [], generated = [], memberRequests = [], sessionRequests = [], stockRequests = [], prompts = [], transforms = [], preparedRequests = [], scheduled = [], scheduleCalls = []
  const available = (options.available ?? ["one", "two", "three"]).map((id) => ({ providerID: provider, id }))
  const globalConfig = options.realDirectory ?? global
  writeFile = async (file, body, opts) => {
    assert.equal(opts.flag, "wx")
    if (options.realDirectory) {
      await options.beforeRealWrite?.(file)
      return realWriteFile(file, body, opts)
    }
    options.beforeWrite?.(file, files)
    if (options.failWrite) throw new Error("disk denied")
    if (files.has(file)) throw Object.assign(new Error("exists"), { code: "EEXIST" })
    const value = JSON.parse(body)
    writes.push([file, value])
    files.set(file, value)
  }
  const fs = {
    readJson: (file) => Effect.sync(() => { reads.push(file); return files.get(file) }),
    readFileString: (file) => options.realDirectory ? Effect.tryPromise({
      try: () => realReadFile(file, "utf8"), catch: (error) => error,
    }) : Effect.suspend(() => {
      reads.push(file)
      if (options.failRead) return Effect.fail(Object.assign(new Error("read denied"), { code: "EACCES" }))
      const value = options.read?.(file, reads.length, files) ?? files.get(file)
      if (value === undefined) return Effect.fail(Object.assign(new Error("not found"), { code: "ENOENT" }))
      return Effect.succeed(typeof value === "string" ? value : JSON.stringify(value))
    }),
    makeDirectory: () => Effect.void,
    ensureDir: (dir) => options.realDirectory ? Effect.tryPromise({
      try: () => mkdir(dir, { recursive: true }), catch: (error) => error,
    }) : Effect.void,
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
    get: (id) => Effect.suspend(() => {
      options.onGet?.(files)
      return options.failGet ? Effect.fail(new Error("session missing"))
        : Effect.succeed({ id, title: "Fixture session", location: { directory: project }, model: { providerID: provider, id: "one" } })
    }),
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
      return Effect.fail(new Error("FORBIDDEN: stock Session.generate called"))
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
      const session = request.system?.[0] === "prepared-session-system"
      const requests = session ? sessionRequests : memberRequests
      requests.push({ request, transport })
      const input = { prompt: request.messages.at(-1).content[0].text, model: request.model, ...(session ? { sessionID: context.sessionID } : {}) }
      generated.push(input)
      const fallback = input.prompt.startsWith("Score EACH") ? '{"scores":[{"member":1,"score":8},{"member":2,"score":6}]}'
        : input.prompt.includes('Return ONLY valid JSON: {"member"') ? '{"member":1}'
        : input.prompt.includes('Return ONLY valid JSON: {"answer"') ? JSON.stringify({answer:`answer-${generated.length}`}) : `answer-${generated.length}`
      const result = (session ? options.sessionGenerate?.(request, sessionRequests.length) : options.memberGenerate?.(request, memberRequests.length)) ?? options.generate?.(input, generated.length) ?? Effect.succeed(fallback)
      return result.pipe(Effect.map((value) => typeof value === "string" ? { text: value, finishReason: { normalized: "stop" } } : value))
    }),
  }
  const sessionContext = {
    history: { initial: [], messages: [Message.user("preserved history")], instructionUpdate: "preserved instruction update" },
    select: (id) => Effect.succeed({ session: { id, model: { providerID: provider, id: "one" } }, instructions: {}, agent: { id: "build", info: {} }, tools: [] }),
    resolveModel: (session, purpose) => {
      assert.deepEqual(purpose, { kind: "primary", agent: "build" })
      return memberModels.resolve(session.model)
    },
    request: { generate: (input) => Effect.sync(() => {
      preparedRequests.push(input)
      return { request: { ...input.model.model.options, model: input.model.model, system: input.system, messages: input.messages, tools: [], ...options.preparedOptions }, options: options.transportOptions }
    }) },
  }
  const schedules = {
    enabled: (directory) => {
      assert.equal(directory, project)
      return Effect.succeed(options.scheduleEnabled !== false)
    },
    list: ({sessionID}) => Effect.sync(() => scheduled.filter((task) => task.sessionID === sessionID)),
    create: (input, invocation) => Effect.suspend(() => {
      assert.deepEqual(invocation, {
        sessionID: "parent-session", agent: "build", source: { type: "tool", messageID: "message-1", id: "call-1" },
      })
      if (options.denySchedulePermission) return Effect.fail(new Error("automation permission denied"))
      if (options.failSchedule) return Effect.fail(new Error("schedule database denied"))
      scheduleCalls.push(input)
      const entry = { ...input, id: `schedule-${scheduled.length + 1}`, status: "active", runCount: 0, nextDueAt: DateTime.makeUnsafe(Date.now()+60000) }
      scheduled.push(entry); return Effect.succeed(entry)
    }),
    remove: (id) => Effect.sync(() => { scheduled.splice(scheduled.findIndex((task) => task.id === id), 1) }),
  }
  const host = {
    location: { directory: project },
    tool: { list: () => Effect.succeed(options.extraTools ?? [...tools.values()]), transform: (register) => Effect.sync(() => {
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
    Effect.provideService(Global.Service, { config: globalConfig }),
    Effect.provideService(FSUtil.Service, fs),
    Effect.provideService(Session.Service, sessions),
    Effect.provideService(Model.Service, { available: () => Effect.succeed(available) }),
    Effect.provideService(MemberModels.Service, memberModels),
    Effect.provideService(MemberClient.Service, memberClient),
    Effect.provideService(Instance.Service, { provide: () => (effect) => Effect.provideService(effect, SessionContext.Service, sessionContext) }),
    Effect.provideService(Database.Service, { db: {} }),
    Effect.provideService(Automation.Service, schedules),
    Effect.provideService(Agents.Service, {}),
    Effect.provideService(Registry.Service, {}),
  )
  await Effect.runPromise(provide(Plugin.effect(host)))
  return {
    tools, commands, files, reads, writes, created, generated, memberRequests, sessionRequests, stockRequests, prompts, transforms, host, provide, preparedRequests, scheduled, scheduleCalls,
    call: (name, input) => Effect.runPromise(provide(tools.get(name).execute(name === "council" ? { mode: "collaborative", ...input } : input, context))),
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
  assert.equal(h.tools.get("council").input.required, undefined, "catalog action does not require a question")
  assert.deepEqual(h.tools.get("council").input.properties.mode.enum, ["independent", "collaborative"])
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
  test(`council ${strategy} keeps its ${count}-call nominal plan across owned members and prepared chair`, async () => {
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
      assert.equal(chair.model.id, "one")
      assert.equal(h.stockRequests.length, 0)
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
  const h = await harness({ generate: (_, index) => index === 2 ? Effect.fail(new Error("member failed")) : Effect.succeed(`answer-${index}`), sessionGenerate: () => Effect.succeed('{"answer":"answer-3"}') })
  const result = output(await h.call("council", { question: "Q", members }))
  assert.equal(h.generated.length, 3)
  assert.match(h.generated[2].prompt, /failed:.*member failed/)
  assert.match(result, /answer-3/)
})

test("chairman failure remains an actionable tool error and is not retried", async () => {
  const h = await harness({ generate: (_, index) => index === 3 ? Effect.fail(new Error("chair failed")) : Effect.succeed("answer") })
  await assert.rejects(h.call("council", { question: "Q", members }), /chair failed/)
  assert.equal(h.generated.length, 3)
})

for (const input of [{ question: " " },
  { question: "Q", members: ["bad-ref"] }, { question: "Q", members: ["/model"] },
  { question: "Q", members: ["provider/"] }, { question: "Q", members: ["test-provider/missing"] }]) {
  test(`council rejects invalid request before creating sessions: ${JSON.stringify(input)}`, async () => {
    const h = await harness()
    await assert.rejects(h.call("council", input), /requires|Invalid member|at least two valid members|Unknown council reviewer/)
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
  assert.match(output(await h.call("council", { question: "Q" })), /No active council members.*seeded/i)
  noCalls(h)
  assert.equal(h.writes.length, 1)
  assert.equal(h.writes[0][0], globalCouncil)
  assert.equal(h.writes[0][1].members[0].model, members[0], "seeding copies the invoking session model but never calls it")
})

test("late config at the final tool write boundary is preserved and not called seeded", async () => {
  const replacement = '{"members":[],"note":"late"}'
  const h = await harness({ beforeWrite: (file, files) => files.set(file, replacement) })
  const result = output(await h.call("council", { question: "Q" }))
  assert.match(result, /preserved existing/)
  assert.doesNotMatch(result, /seeded a template/)
  assert.equal(h.files.get(globalCouncil), replacement)
})

test("exclusive council writer protects real late writes and concurrent seeds", async () => {
  const parent = path.join(tmpdir(), "opencode")
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(path.join(parent, "council-seed-"))
  const file = path.join(directory, "council.json")
  const fs = { ensureDir: (dir) => Effect.tryPromise({ try: () => mkdir(dir, { recursive: true }), catch: (error) => error }) }
  try {
    writeFile = async (...args) => {
      await realWriteFile(file, '{"members":[],"late":true}')
      return realWriteFile(...args)
    }
    assert.equal(await Effect.runPromise(legacy.writeJsonSafe(fs, file, { members: ["seed"] })), false)
    assert.equal(await realReadFile(file, "utf8"), '{"members":[],"late":true}')
    rmSync(file)
    writeFile = realWriteFile
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      Effect.runPromise(legacy.writeJsonSafe(fs, file, { members: [i] }))))
    assert.equal(results.filter(Boolean).length, 1)
    const saved = JSON.parse(await realReadFile(file, "utf8"))
    assert.equal(saved.members.length, 1)
    for (const raw of ["", "  ", "{}", "{bad", '{"members":[]}']) {
      await realWriteFile(file, raw)
      assert.equal(await Effect.runPromise(legacy.writeJsonSafe(fs, file, { members: ["seed"] })), false)
      assert.equal(await realReadFile(file, "utf8"), raw)
    }
  } finally {
    writeFile = realWriteFile
    rmSync(directory, { recursive: true, force: true })
  }
})

test("actual council tool preserves a real concurrent file written after its final read", async () => {
  const parent = path.join(tmpdir(), "opencode")
  mkdirSync(parent, { recursive: true })
  const directory = mkdtempSync(path.join(parent, "council-tool-"))
  const replacement = '{"members":[],"note":"late real write"}'
  try {
    const h = await harness({ realDirectory: directory, beforeRealWrite: (file) => realWriteFile(file, replacement) })
    const result = output(await h.call("council", { question: "Q" }))
    assert.match(result, /preserved existing/)
    assert.doesNotMatch(result, /seeded a template/)
    assert.equal(await realReadFile(path.join(directory, "council.json"), "utf8"), replacement)
  } finally {
    writeFile = realWriteFile
    rmSync(directory, { recursive: true, force: true })
  }
})

test("schedule add/list/export/remove delegates to the executable session engine, not JSON records", async () => {
  const h = await harness()
  assert.match(output(await h.call("schedule_task", { action: "add", name: "review", cadence: "@daily", prompt: "review files" })), /Scheduled/)
  const first = h.scheduled[0]
  assert.deepEqual(first.trigger, { type: "cron", cron: "0 9 * * *" })
  assert.deepEqual(first.action, { type: "prompt", prompt: "review files" })
  assert.equal(first.sessionID, context.sessionID)
  assert.equal(h.writes.length, 0)
  assert.match(output(await h.call("schedule_task", { action: "list" })), /review/)
  const exported = JSON.parse(output(await h.call("schedule_task", { action: "export" })))
  assert.equal(exported.tasks[0].id, first.id)
  assert.equal(exported.legacy.active, false)
  await assert.rejects(h.call("schedule_task", { action: "add", name: "review", cadence: "@hourly", prompt: "updated" }), /already exists/)
  assert.equal(h.scheduled.length, 1)
  assert.match(output(await h.call("schedule_task", { action: "remove", name: "review" })), /Removed "review"/)
  assert.match(output(await h.call("schedule_task", { action: "list" })), /No executable schedules/)
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

test("schedule engine failure surfaces instead of pretending success", async () => {
  const h = await harness({ failSchedule: true })
  await assert.rejects(h.call("schedule_task", { action: "add", name: "n", cadence: "@daily", prompt: "p" }), /schedule database denied/)
  assert.equal(h.writes.length, 0)
  noCalls(h)
})

test("scheduler normalizes aliases for the automation engine", () => {
  assert.equal(legacy.normalizeCadence("@daily"), "0 9 * * *")
  assert.equal(legacy.normalizeCadence("every 15 minutes"), "every 15 minutes")
  assert.equal(legacy.normalizeCadence("every 2 hours"), "every 2 hours")
  assert.equal(legacy.normalizeCadence("not a cadence"), undefined)
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

test("unknown council strategies fail rather than silently choosing a different plan", async () => {
  const h = await harness()
  await assert.rejects(h.call("council", { question: "Q", members, strategy: "unknown-legacy-alias" }), /Unknown council strategy/)
  noCalls(h)
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
  assert.match(result, /complete answer \(length\)/)
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
  assert.deepEqual(decorate({ requirements }).requirements.nodes, [requirements, modelNode, Instance.node, Database.node])
})

test("R facade exports the shared member resolver requirements as well as list", () => {
  const manifest = JSON.parse(readFileSync(new URL(".personalize/R.json", root), "utf8"))
  const entry = manifest.modules.find((item) => item.target === "packages/core/src/plugin/internal.ts")
  assert.equal(entry.factory, "packages/core/src/personalize/tools.ts")
  assert.deepEqual(entry.exports, ["list", "requirements"])
})

test("missing upstream caps are restored on member and prepared session requests", async () => {
  const h = await harness({memberOptions:{}})
  await h.call("council", { question:"Q", members, strategy:"council" })
  assert.ok([...h.memberRequests, ...h.sessionRequests].every(({request})=>request.maxTokens===16000))
})
test.todo("live binary serialization and upstream billing require separately authorized, bounded evidence")

for (const raw of ['{bad', 'null', '[]', 'false', '0', '{"members":"wrong"}', '{"members":[{"model":123}]}']) {
  test(`nonempty invalid config is preserved: ${raw}`, async () => {
    const h = await harness({ files: [[globalCouncil, raw]] })
    await assert.rejects(h.call("council", {question:"Q"}), /Invalid JSON|Invalid council/)
    assert.equal(h.files.get(globalCouncil), raw)
    assert.equal(h.writes.length, 0)
    noCalls(h)
  })
}
for (const raw of ['', ' \r\n\t', '{}', ' { } ']) {
  test(`empty config is preserved rather than overwritten: ${JSON.stringify(raw)}`, async () => {
    const h = await harness({ files: [[globalCouncil, raw]] })
    assert.match(output(await h.call("council", {question:"Q"})), /preserved existing/)
    assert.equal(h.files.get(globalCouncil), raw)
    assert.equal(h.writes.length, 0)
    noCalls(h)
  })
}
test("read denial and intentionally blank member lists never become replacement templates", async () => {
  const denied = await harness({failRead:true})
  await assert.rejects(denied.call("council",{question:"Q"}), /read denied/)
  assert.equal(denied.writes.length, 0)
  const existing = {members:[], note:"keep me"}
  const blank = await harness({files:[[globalCouncil,existing]]})
  assert.match(output(await blank.call("council",{question:"Q"})), /preserved existing/)
  assert.deepEqual(blank.files.get(globalCouncil),existing)
  assert.equal(blank.writes.length,0)
})
test("template recheck protects a newly written config and excludes an unavailable current model", async () => {
  let globalReads=0
  const replacement={members:[],note:"concurrent user edit"}
  const h=await harness({read:(file,_,files)=>{
    if(file===globalCouncil && ++globalReads===2) files.set(file,replacement)
  }})
  await h.call("council",{question:"Q"})
  assert.equal(h.writes.length,0)
  assert.deepEqual(h.files.get(globalCouncil),replacement)
  const missing=await harness({available:["two"]})
  await missing.call("council",{question:"Q"})
  assert.ok(missing.files.get(globalCouncil).members.every((entry)=>entry.model===''))
})

test("blank project members override global config without creating or resetting any template", async () => {
  const projectConfig = { members: [{ name: "pending", model: "" }], note: "intentional" }
  const h = await harness({ files: [[projectCouncil, projectConfig], [globalCouncil, { members: members.map((model) => ({ model })) }]] })
  const result = output(await h.call("council", { question: "Q" }))
  assert.ok(result.includes(projectCouncil))
  assert.match(result, /preserved existing/)
  assert.deepEqual(h.files.get(projectCouncil), projectConfig)
  assert.equal(h.writes.length, 0)
  noCalls(h)
})

test("template rechecks contents after session lookup yields", async () => {
  const config = { members: [], note: "written during lookup" }
  const h = await harness({ onGet: (files) => files.set(globalCouncil, config) })
  await h.call("council", { question: "Q" })
  assert.deepEqual(h.files.get(globalCouncil), config)
  assert.equal(h.writes.length, 0)
})

test("owned chair preserves prepared session metadata and transport hooks on an identical length retry", async () => {
  const seen = []
  const transports = { http: (wire, next) => next(HttpClientRequest.setHeader(wire, "x-hook", "preserved")), webSocket: () => {} }
  const h = await harness({
    preparedOptions: { headers: { "x-opencode-session-id": context.sessionID }, promptCacheKey: "session-cache" },
    transportOptions: transports,
    sessionGenerate: (_, attempt) => Effect.succeed(attempt === 1
      ? { text: "partial", finishReason: { normalized: "length" } }
      : '{"answer":"complete"}'),
  })
  await h.call("council", { question: "Q", members })
  assert.equal(h.sessionRequests.length, 2)
  const [first, second] = h.sessionRequests
  assert.equal(first.request, second.request)
  assert.equal(first.transport, transports)
  assert.equal(second.transport, transports)
  assert.equal(first.request.headers["x-opencode-session-id"], context.sessionID)
  assert.equal(first.request.promptCacheKey, "session-cache")
  await Effect.runPromise(first.transport.http(HttpClientRequest.post("https://fixture.invalid"), (wire) => Effect.sync(() => seen.push(wire))))
  assert.equal(seen[0].headers["x-hook"], "preserved")
  assert.equal(first.request.maxTokens, 2400)
  assert.equal(h.stockRequests.length, 0)
})

const ballot=(one=8,two=6)=>JSON.stringify({scores:[{member:1,score:one},{member:2,score:two}]})
for (const invalid of ['not JSON','{}','[]','null',ballot(999),ballot(0),'{"scores":[{"member":1,"score":8},{"member":1,"score":7}]}','{"scores":[{"member":1,"score":8}]}','{"scores":[{"member":1,"score":8,"extra":1},{"member":2,"score":7}]}']) {
  test(`strict ballot schema rejects ${invalid}`,()=>assert.equal(legacy.validateBallot(invalid,2).ok,false))
}
test("one invalid ballot rejects the whole peer round; all peers correct and earlier scores are discarded",async()=>{
  const rounds=new Map()
  const h=await harness({memberGenerate:(request)=>{
    const prompt=request.messages[0].content[0].text
    if(!prompt.startsWith('Score EACH')) return Effect.succeed('candidate answer')
    const n=(rounds.get(request.model.id)??0)+1; rounds.set(request.model.id,n)
    return Effect.succeed(n===1 ? (request.model.id==='one'?'bad JSON':ballot(1,10)) : ballot())
  }})
  const text=output(await h.call('council',{question:'Q',members,strategy:'consensus'}))
  assert.deepEqual([...rounds.values()],[2,2])
  assert.equal(h.memberRequests.length,6)
  assert.equal(h.sessionRequests.length,0)
  assert.match(text,/- member1: 16/)
  assert.match(text,/- member2: 12/)
  assert.ok(h.memberRequests.slice(-2).every(({request})=>request.messages[0].content[0].text.includes('entire peer voting round was rejected')))
  assert.ok(h.memberRequests.every(({request})=>request.maxTokens===2400))
})
for(const reply of ['invalid',ballot(7,7)]) test(`invalid or tied consensus never invents a winner: ${reply}`,async()=>{
  const h=await harness({memberGenerate:(request)=>Effect.succeed(request.messages[0].content[0].text.startsWith('Score EACH')?reply:'candidate')})
  await assert.rejects(h.call('council',{question:'Q',members,strategy:'consensus'}),/No valid consensus after one corrective round/)
  assert.equal(h.memberRequests.length,6)
  assert.equal(h.sessionRequests.length,0)
})
test('member display names cannot inject ballot regular expressions',async()=>{
  const h=await harness({files:[[projectCouncil,{members:[{name:'(',model:members[0]},{name:'[',model:members[1]}]}]]})
  assert.match(output(await h.call('council',{question:'Q',strategy:'consensus'})),/Winner: \(/)
})

test("a failed ballot generation cannot become a general-error corrective retry", async () => {
  const h = await harness({ memberGenerate: (request) => request.messages[0].content[0].text.startsWith("Score EACH")
    ? Effect.fail(new Error("provider unavailable")) : Effect.succeed("candidate answer") })
  await assert.rejects(h.call("council", { question: "Q", members, strategy: "consensus" }), /ballot generation failed/)
  assert.equal(h.memberRequests.length, 4)
  assert.equal(h.sessionRequests.length, 0)
})
for(const strategy of ['router','council','moa','debate']) test(`invalid ${strategy} leader JSON corrects only the leader`,async()=>{
  const h=await harness({sessionGenerate:(_,attempt)=>Effect.succeed(attempt===1?'invalid JSON':strategy==='router'?'{"member":2}':'{"answer":"corrected answer"}')})
  await h.call('council',{question:'Q',members,strategy})
  assert.equal(h.sessionRequests.length,2)
  assert.equal(h.memberRequests.length,strategy==='router'?1:strategy==='debate'?4:2)
  assert.match(h.sessionRequests[1].request.messages.at(-1).content[0].text,/previous structured result was rejected/)
  assert.equal(h.stockRequests.length,0)
})
test('leader invalid JSON stops after one correction with no guessed router member',async()=>{
  const h=await harness({sessionGenerate:()=>Effect.succeed('{"member":99}')})
  await assert.rejects(h.call('council',{question:'Q',members,strategy:'router'}),/Leader JSON invalid/)
  assert.equal(h.sessionRequests.length,2)
  assert.equal(h.memberRequests.length,0)
})
test('owned session preparation preserves system, history, instruction update and parent session',async()=>{
  const h=await harness()
  await h.call('council',{question:'Q',members})
  const request=h.sessionRequests[0].request
  assert.deepEqual(request.system,['prepared-session-system'])
  assert.equal(request.messages[0].content[0].text,'preserved history')
  assert.equal(request.messages[1].content[0].text,'preserved instruction update')
  assert.equal(h.preparedRequests[0].session.id,context.sessionID)
  assert.equal(h.stockRequests.length,0)
})
test('distill discards two truncated responses and never writes a partial skill',async()=>{
  const h=await harness({messages:successfulHistory,sessionGenerate:()=>Effect.succeed({text:'partial',finishReason:{normalized:'length'}})})
  await assert.rejects(h.call('distill_session',{action:'run'}),/complete answer \(length\)/)
  assert.equal(h.sessionRequests.length,2)
  assert.equal(h.sessionRequests[0].request,h.sessionRequests[1].request)
  assert.equal(h.writes.length,0)
  assert.equal(h.stockRequests.length,0)
})
for(const reason of ['unknown','content-filter','tool-calls']) test(`non-stop completion is rejected without retry: ${reason}`,async()=>{
  const h=await harness({messages:successfulHistory,sessionGenerate:()=>Effect.succeed({text:'partial',finishReason:{normalized:reason}})})
  await assert.rejects(h.call('distill_session',{}),/complete answer/)
  assert.equal(h.sessionRequests.length,1)
  assert.equal(h.writes.length,0)
})
test('real Cron rejects invalid fields; interval cadence retains 90 minutes and seven hours',async()=>{
  const h=await harness()
  for(const invalid of ['bad bad bad bad bad','99 * * * *','every 0 minutes']) {
    assert.equal(legacy.normalizeCadence(invalid),undefined)
    await assert.rejects(h.call('schedule_task',{action:'add',name:'bad',cadence:invalid,prompt:'work'}),/Unparseable/)
  }
  assert.equal(h.scheduleCalls.length,0)
  await h.call('schedule_task',{action:'add',name:'interval',cadence:'every 90 minutes',prompt:'do work'})
  await h.call('schedule_task',{action:'add',name:'long interval',cadence:'every 7 hours',prompt:'do work'})
  assert.deepEqual(h.scheduleCalls[0].trigger,{type:'every',every:'90 minutes'})
  assert.deepEqual(h.scheduleCalls[1].trigger,{type:'every',every:'7 hours'})
})
test('disabled execution reports the required flag instead of creating a fake schedule',async()=>{
  const h=await harness({scheduleEnabled:false})
  await assert.rejects(h.call('schedule_task',{action:'add',name:'job',cadence:'@daily',prompt:'work'}),/experimental.automations/)
  assert.equal(h.scheduleCalls.length+h.writes.length,0)
})
test('automation permission rejection prevents schedule creation',async()=>{
  const h=await harness({denySchedulePermission:true})
  await assert.rejects(h.call('schedule_task',{action:'add',name:'job',cadence:'@daily',prompt:'work'}),/automation permission denied/)
  assert.equal(h.scheduled.length,0)
})
test('legacy JSON schedules are export-only and are not silently activated',async()=>{
  const old={tasks:[{name:'old',cadence:'* * * * *',prompt:'old work'}]}
  const h=await harness({files:[[scheduleFile,old]]})
  assert.match(output(await h.call('schedule_task',{action:'list'})),/No executable schedules/)
  const exported=JSON.parse(output(await h.call('schedule_task',{action:'export'})))
  assert.deepEqual(exported.legacy.data,old)
  assert.equal(exported.legacy.active,false)
  assert.equal(h.scheduleCalls.length+h.writes.length,0)
})

test("council catalog exposes every mode/strategy/alias without reading config or calling models", async () => {
  const h = await harness()
  const catalog = output(await h.call("council", { action: "list_modes" }))
  for (const name of ["independent", "collaborative", "council", "compare", "debate", "moa", "router", "consensus", "arena", "synth", "roundtable", "sidebyside", "map", "route", "vote"]) assert.ok(catalog.includes(name))
  assert.equal(h.reads.length + h.writes.length, 0)
  noCalls(h)
})

test("default independent mode preserves duplicate equal-tier slots and uses a separate fresh blind judge", async () => {
  const h = await harness()
  await h.call("council", { mode: undefined, question: "Inspect the supplied evidence", members: [members[0], members[0], members[1]], judge: `${provider}/three` })
  assert.deepEqual(h.created.map(x => x.model.id), ["one", "one", "two", "three"])
  assert.equal(h.sessionRequests.length + h.stockRequests.length, 0)
  for (const { request } of h.memberRequests) {
    assert.equal(request.messages.length, 1)
    assert.ok(request.messages.every(x => !JSON.stringify(x).includes("preserved history")))
  }
  const prompt = h.memberRequests.at(-1).request.messages[0].content[0].text
  for (const name of ["Reviewer 1", "Reviewer 2", "Reviewer 3"]) assert.ok(prompt.includes(name))
  assert.ok(!prompt.includes(provider), "judge receives anonymized slots, not provider/model identities")
})

test("independent debate self-revision cannot see another reviewer's answer", async () => {
  const h = await harness({ memberGenerate: (request, count) => Effect.succeed(request.messages[0].content[0].text.includes("Return ONLY valid JSON")
    ? '{"answer":"judged"}' : `PRIVATE-ANSWER-${count}`) })
  await h.call("council", { mode: "independent", strategy: "debate", question: "Q", members })
  const prompts = h.memberRequests.map(x => x.request.messages[0].content[0].text)
  assert.ok(prompts[2].includes("PRIVATE-ANSWER-1"))
  assert.ok(!prompts[2].includes("PRIVATE-ANSWER-2"))
  assert.ok(prompts[3].includes("PRIVATE-ANSWER-2"))
  assert.ok(!prompts[3].includes("PRIVATE-ANSWER-1"))
  assert.equal(h.sessionRequests.length, 0)
  assert.equal(h.memberRequests.length, 5)
})

test("collaborative debate deliberately exchanges peer answers", async () => {
  const h = await harness()
  await h.call("council", { mode: "collaborative", strategy: "debate", question: "Q", members })
  for (const { request } of h.memberRequests.slice(2)) {
    const prompt = request.messages[0].content[0].text
    assert.ok(prompt.includes("answer-1") && prompt.includes("answer-2"))
  }
})

test("independent consensus and missing panel slots fail before any generation", async () => {
  for (const input of [
    { mode: "independent", strategy: "consensus", members },
    { mode: "independent", members: [members[0], members[1], `${provider}/missing`] },
  ]) {
    const h = await harness()
    await assert.rejects(h.call("council", { question: "Q", ...input }), /requires mode=collaborative|Unknown council reviewer/)
    noCalls(h)
  }
})

function agentTools(calls, visible, run) {
  return [
    { name: "subagent_capabilities", execute: ({ agent }) => Effect.succeed({ metadata: { subagentCapabilities: { verified: true, tools: visible(agent) } } }) },
    { name: "subagent", execute: input => Effect.suspend(() => { calls.push(input); return Effect.succeed(run(input)) }) },
  ]
}

test("judge execution capabilities are checked before any reviewers or agents start", async () => {
  const calls = []
  const h = await harness({ extraTools: agentTools(calls, () => ["read"], () => { throw new Error("must not execute") }) })
  await assert.rejects(h.call("council", { mode: "independent", question: "Q", members, judge_agent: "general", judge_tools: ["shell"] }), /lacks required tools: shell/)
  assert.equal(calls.length, 0)
  noCalls(h)
})

test("tool-enabled equal-tier reviewers submit to a separate fresh judge/tester", async () => {
  const calls = []
  const h = await harness({ extraTools: agentTools(calls, agent => agent === "tester" ? ["read", "shell"] : ["read", "council"],
    input => ({ output: { status: "completed", sessionID: `child-${calls.length}`, output: input.agent === "tester" ? '{"answer":"fixture checks executed"}' : `review-${calls.length}` } })) })
  const result = output(await h.call("council", { mode: "independent", question: "Q", members: [members[0], members[0], members[1]], judge: `${provider}/three`,
    reviewer_agent: "general", reviewer_tools: ["read", "council"], judge_agent: "tester", judge_tools: ["shell"] }))
  assert.equal(calls.length, 4)
  assert.deepEqual(calls.map(x => x.model), [members[0], members[0], members[1], `${provider}/three`])
  assert.ok(calls.every(x => x.sessionID === undefined && x.background === false))
  assert.ok(calls.slice(0, 3).every(x => !x.prompt.includes("review-")))
  assert.ok(calls[3].prompt.includes("review-1") && calls[3].prompt.includes("review-2") && calls[3].prompt.includes("review-3"))
  assert.equal(h.generated.length, 0)
  assert.match(result, /fixture checks executed/)
})

test("backgrounded reviewer work cannot be passed off as completed evidence", async () => {
  const calls = []
  const h = await harness({ extraTools: agentTools(calls, () => ["read"], () => ({ output: { status: "backgrounded", output: "still running" } })) })
  await assert.rejects(h.call("council", { mode: "independent", question: "Q", members, reviewer_agent: "general" }), /panel is incomplete/)
  assert.equal(calls.length, 2)
  assert.equal(h.generated.length, 0)
})

test("partial duplicate panel preserves ordered findings despite out-of-order completion", async () => {
  const gate = await Effect.runPromise(Deferred.make())
  const finished = []
  const h = await harness({ memberGenerate: (_request, count) => Effect.gen(function* () {
    if (count === 1) yield* Deferred.await(gate)
    if (count === 2) return yield* Effect.fail(new Error("slot two failed"))
    finished.push(count)
    if (count === 3) yield* Deferred.succeed(gate, undefined)
    return `findings-${count}`
  }) })
  await assert.rejects(h.call("council", { mode: "independent", question: "Q", members: [members[0], members[0], members[1]] }), error => {
    const result = error.metadata.council
    assert.equal(result.status, "incomplete_panel")
    assert.deepEqual(result.rounds[0].slots.map(x => [x.slot, x.model, x.status]), [
      [1, members[0], "completed"], [2, members[0], "failed"], [3, members[1], "completed"],
    ])
    assert.match(error.message, /findings-1/)
    assert.match(error.message, /findings-3/)
    assert.match(result.rounds[0].slots[1].answer, /slot two failed/)
    return true
  })
  assert.deepEqual(finished, [3, 1])
  assert.equal(h.generated.length, 3, "no judge or replacement reviewer")
})

for (const strategy of ["council", "moa", "debate"]) {
  for (const failure of ["provider", "json"]) {
    test(`${strategy} preserves completed findings after judge ${failure} failure`, async () => {
      const h = await harness({ memberGenerate: (request, count) =>
        request.messages[0].content[0].text.includes("Return ONLY valid JSON:")
          ? failure === "provider" ? Effect.fail(new Error("judge provider failed")) : Effect.succeed("invalid")
          : Effect.succeed(`findings-${count}`) })
      await assert.rejects(h.call("council", { mode: "independent", strategy, rounds: 1, question: "Q", members }), error => {
        assert.equal(error.metadata.council.status, "final_stage_failed")
        assert.deepEqual(error.metadata.council.rounds[0].slots.map(x => x.answer), ["findings-1", "findings-2"])
        assert.match(error.message, failure === "provider" ? /judge provider failed/ : /one corrective retry/)
        assert.match(error.message, /findings-1/)
        assert.match(error.message, /findings-2/)
        return true
      })
      assert.equal(h.generated.length, failure === "provider" ? 3 : 4)
    })
  }
}

test("later debate failure retains all prior rounds and completed current slots", async () => {
  const h = await harness({ memberGenerate: (_request, count) =>
    count === 4 ? Effect.fail(new Error("round two failure")) : Effect.succeed(`round-evidence-${count}`) })
  await assert.rejects(h.call("council", { mode: "independent", strategy: "debate", question: "Q", members }), error => {
    assert.deepEqual(error.metadata.council.rounds.map(x => x.round), [1, 2])
    assert.deepEqual(error.metadata.council.rounds[0].slots.map(x => x.answer), ["round-evidence-1", "round-evidence-2"])
    assert.equal(error.metadata.council.rounds[1].slots[0].answer, "round-evidence-3")
    assert.match(error.message, /round two failure/)
    return true
  })
  assert.equal(h.generated.length, 4)
})

for (const role of ["reviewer", "judge"]) {
  test(`running ${role} retains its continuation handle without a retry`, async () => {
    const calls = []
    const h = await harness({ extraTools: agentTools(calls, () => ["read", "shell"],
      () => ({ output: { status: "running", sessionID: `running-${calls.length}` } })) })
    await assert.rejects(h.call("council", {
      mode: "independent", question: "Q", members,
      ...(role === "reviewer" ? { reviewer_agent: "general" } : { judge_agent: "tester", judge_tools: ["shell"] }),
    }), error => {
      const result = error.metadata.council
      if (role === "reviewer") {
        assert.equal(result.status, "incomplete_panel")
        assert.deepEqual(result.rounds[0].slots.map(x => [x.slot, x.status, x.sessionID]), [
          [1, "running", "running-1"], [2, "running", "running-2"],
        ])
      } else {
        assert.equal(result.status, "final_stage_pending")
        assert.deepEqual(result.stage, { role: "judge", status: "running", sessionID: "running-1", output: "" })
        assert.equal(result.rounds[0].slots.length, 2)
      }
      assert.match(error.message, /running-1/)
      return true
    })
    assert.equal(calls.length, role === "reviewer" ? 2 : 1)
    assert.equal(h.generated.length, role === "reviewer" ? 0 : 2)
  })
}

test("router rejects final tester options before starting any role", async () => {
  const calls = []
  const h = await harness({ extraTools: agentTools(calls, () => ["shell"], () => { throw Error("must not run") }) })
  await assert.rejects(h.call("council", { mode: "independent", strategy: "router", question: "Q", members,
    judge_agent: "tester", judge_tools: ["shell"] }), /selector-only/)
  noCalls(h)
  assert.equal(calls.length, 0)
  const result = output(await h.call("council", { mode: "independent", strategy: "router", question: "Q", members }))
  assert.match(result, /Final stage: none \(text selector only\)/)
})
