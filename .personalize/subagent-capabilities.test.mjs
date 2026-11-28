import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire, registerHooks, stripTypeScriptTypes } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"
import test from "node:test"

const root = (process.env.PERSONALIZE_SOURCE ?? fileURLToPath(new URL("../", import.meta.url))).replaceAll("\\", "/").replace(/\/?$/, "/")
const requireCore = createRequire(root + "packages/core/package.json")
const effectURL = process.env.PERSONALIZE_EFFECT ?? pathToFileURL(requireCore.resolve("effect")).href
const helperURL = pathToFileURL(root + "packages/core/src/personalize/subagent-capabilities.ts").href
// Only boundary/schema dependencies are doubled. Effects, permission policy and the runtime schema converter are real.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "effect") return { url: effectURL, shortCircuit: true }
    if (specifier === "@opencode/schema/tool")
      return { url: pathToFileURL(root + "packages/schema/src/tool.ts").href, shortCircuit: true }
    if (specifier === "@opencode/util/record")
      return { url: pathToFileURL(root + "packages/util/src/record.ts").href, shortCircuit: true }
    if (specifier.endsWith("/permission/policy.js"))
      return { url: pathToFileURL(root + "packages/core/src/permission/policy.ts").href, shortCircuit: true }
    if (specifier === "./policy.js" && context.parentURL.endsWith("/permission/policy.ts"))
      return { url: context.parentURL, shortCircuit: true }
    if (specifier.endsWith("/util/wildcard.js"))
      return { url: pathToFileURL(root + "packages/core/src/util/wildcard.ts").href, shortCircuit: true }
    if (specifier === "./wildcard.js" && context.parentURL.endsWith("/util/wildcard.ts"))
      return { url: context.parentURL, shortCircuit: true }
    if (specifier.endsWith("/session/schema.js")) return { url: "fixture:session", shortCircuit: true }
    if (specifier.endsWith("/tool/runtime.js")) return { url: "fixture:runtime", shortCircuit: true }
    if (specifier === "./tool.js" && context.parentURL.endsWith("/packages/schema/src/tool.ts"))
      return { url: context.parentURL, shortCircuit: true }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url === "fixture:session") return {
      format: "module", shortCircuit: true,
      source: `import {Schema} from "effect"; export const SessionSchema = {ID: Schema.String};`,
    }
    if (url === "fixture:runtime") {
      let source = readFileSync(root + "packages/core/src/tool/runtime.ts", "utf8")
      source = source.replace(/^import .*from "@opencode\/ai\/effect"\r?$/m,
        `const annotationKeywords = new Set(["title", "description", "default", "examples", "readOnly", "writeOnly"]);
        ${readFileSync(root + "packages/ai/src/tool.ts", "utf8").match(/export const emptyInputJsonSchema =[\s\S]*?\r?\n\}/)[0].replace("export ", "")}
        class ToolFailure extends Error {}`)
      source = source.replace(/^import .*from "zod\/v4\/core"\r?$/m,
        "class $ZodType {}; const toJSONSchema = () => {throw new Error('Zod not exercised')}")
      return { format: "module", shortCircuit: true, source: stripTypeScriptTypes(source) }
    }
    if (url.endsWith(".ts"))
      return { format: "module", shortCircuit: true, source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8")) }
    return next(url, context)
  },
})

const { Effect, Schema } = await import("effect")
const { PermissionPolicy } = await import(pathToFileURL(root + "packages/core/src/permission/policy.ts").href)
const { registerSubagentCapabilities } = await import(helperURL)
const caller = { sessionID: "parent" }
function fixture(options = {}) {
  let calls = 0
  const snapshots = []
  const result = options.result ?? { content: "stock", metadata: { stock: true }, output: { preserved: true } }
  const input = options.input ?? { type: "object", properties: { agent: { type: "string" } }, required: ["agent"] }
  const original = { name: "subagent", description: "stock", input, output: Schema.String,
    options: { codemode: false }, execute: (value, context) => {
      calls++
      assert.equal(context, caller)
      assert.equal("required_tools" in value, false)
      assert.equal(value.background, true)
      assert.equal(value.model, "provider/model")
      return options.fail ? Effect.fail(options.fail) : Effect.succeed(result)
    } }
  const tools = new Map([["subagent", original]])
  registerSubagentCapabilities({
    add: (tool) => tools.set(tool.name, tool),
    update: (name, fn) => fn(tools.get(name)),
  }, {
    agents: { resolve: (name) => Effect.succeed(
      name === "unknown" ? undefined : { id: name, mode: name === "primary" ? "primary" : "subagent",
        permissions: options.agentPermissions ?? [{ action: "*", resource: "*", effect: "deny" }] }) },
    sessions: { get: (id) => id === "missing" || (id === "parent" && options.parentMissing) ? Effect.fail(new Error("missing")) : Effect.succeed({
      id, parentID: id === "foreign" ? "other" : "parent", agent: "old",
      permissions: (id === "parent" ? options.parentPermissions : options.childPermissions) ?? [{ action: "read", resource: "*", effect: "allow" }],
    }) },
    registry: { snapshot: (policy) => {
      assert.equal(policy._tag, "rules", "snapshot requires a PermissionPolicy, not a raw rules array")
      snapshots.push(policy)
      if (options.permissionFiltered) return Effect.succeed({
        definitions: PermissionPolicy.isActionDenied(policy, "shell") ? [] : [{ name: "shell" }],
      })
      return Effect.succeed({
        definitions: options.readOnly ? [{ name: "read" }] : [{ name: "read" }, { name: "execute" }],
        codeModeCatalog: options.readOnly ? undefined : { tools: new Map([["council", {}], ["read", {}]]) },
      })
    } },
  })
  return { tools, snapshots, result, original, calls: () => calls }
}
const invoke = (f, name, input) => Effect.runPromise(f.tools.get(name).execute(name === "subagent" ? { required_tools: [], ...input } : input, caller))
test("missing capability contract is rejected before spawning", async () => {
  const f = fixture()
  await assert.rejects(Effect.runPromise(f.tools.get("subagent").execute({ agent: "general" }, caller)), /Declare required_tools/)
  assert.equal(f.calls(), 0)
  assert.ok(f.tools.get("subagent").input.required.includes("required_tools"))
})
test("reports registered names including code-mode catalog; visibility is not authorization", async () => {
  const f = fixture()
  const result = await invoke(f, "subagent_capabilities", { agent: "general", sessionID: "child" })
  const caps = result.metadata.subagentCapabilities
  assert.deepEqual(caps.tools, ["council", "execute", "read"])
  assert.equal(caps.approvalMayBeRequired, true)
  assert.equal(caps.authorization, "visibility_only")
  assert.equal(f.snapshots[0].rules.length, 2)
  assert.match(result.content, /not authorization/)
})
test("rejects unknown, primary, missing and foreign children without snapshot or execution", async () => {
  for (const input of [{ agent: "unknown" }, { agent: "primary" },
    { agent: "general", sessionID: "foreign" }, { agent: "general", sessionID: "missing" }]) {
    const f = fixture()
    await assert.rejects(invoke(f, "subagent_capabilities", input))
    await assert.rejects(invoke(f, "subagent", input))
    assert.equal(f.calls(), 0)
    assert.equal(f.snapshots.length, 0)
  }
})
test("required tool failure lists missing and available tools and never executes stock", async () => {
  const f = fixture()
  await assert.rejects(invoke(f, "subagent", { agent: "general", required_tools: ["shell"] }),
    /missing required tools: shell.*Available tools: council, execute, read/)
  assert.equal(f.calls(), 0)
})
test("forwards stock fields, preserves output/options/schema, attaches verified metadata", async () => {
  const f = fixture()
  const outputSchema = f.original.output
  const options = f.original.options
  const result = await invoke(f, "subagent", {
    agent: "general", sessionID: "child", model: "provider/model", background: true,
    required_tools: ["council"],
  })
  assert.equal(f.calls(), 1)
  assert.equal(result.output, f.result.output)
  assert.equal(result.metadata.stock, true)
  assert.equal(result.metadata.subagentCapabilities.agent, "general")
  assert.deepEqual(result.content[0], { type: "text", text: "stock" })
  assert.match(result.content[1].text, /^Verified/)
  assert.equal(f.original.output, outputSchema)
  assert.equal(f.original.options, options)
  assert.deepEqual(f.original.input.required, ["agent", "required_tools"])
  assert.equal(f.original.input.properties.required_tools.items.type, "string")
})
test("stock failure identity preserved and malformed requirements rejected", async () => {
  const fail = new Error("stock failure")
  const f = fixture({ fail })
  const error = await Effect.runPromise(Effect.flip(f.tools.get("subagent").execute({
    agent: "general", background: true, model: "provider/model", required_tools: [],
  }, caller)))
  assert.equal(error, fail)
  await assert.rejects(invoke(f, "subagent", { agent: "general", required_tools: [1] }), /array of strings/)
  assert.equal(f.calls(), 1)
})
test("Effect schema converted using actual runtime converter", () => {
  const f = fixture({ input: Schema.Struct({ agent: Schema.String }) })
  assert.equal(f.original.input.type, "object")
  assert.equal(f.original.input.properties.agent.type, "string")
  assert.equal(f.original.input.properties.required_tools.type, "array")
})
test("read-only snapshot cannot satisfy executor assignment; permissions retained in order", async () => {
  const f = fixture({ readOnly: true })
  await assert.rejects(invoke(f, "subagent", {
    agent: "general", sessionID: "child", required_tools: ["shell", "council"],
  }), /missing required tools: shell, council.*Available tools: read/)
  assert.deepEqual(f.snapshots[0].rules, [
    { action: "*", resource: "*", effect: "deny" },
    { action: "read", resource: "*", effect: "allow" },
  ])
  assert.equal(f.calls(), 0)
})
test("content blocks and absent content handled without changing stock output", async () => {
  for (const content of [undefined, [{ type: "text", text: "block" }]]) {
    const f = fixture({ result: { content, output: { status: "running" } } })
    const result = await invoke(f, "subagent", {
      agent: "general", background: true, model: "provider/model",
    })
    assert.deepEqual(result.content.slice(0, -1), content ?? [{ type: "text", text: JSON.stringify(f.result.output) }])
    assert.match(result.content.at(-1).text, /Verified visible tools/)
    assert.equal(result.output, f.result.output)
  }
})
test("unrecognized schema shape rejected instead of silently dropping constraints", () => {
  assert.throws(() => fixture({ input: { anyOf: [{ type: "object" }] } }), /object input JSON schema/)
  assert.throws(() => fixture({ input: { type: "object", properties: {}, required: {} } }), /string input requirement names/)
})

const shell = effect => [{ action: "shell", resource: "*", effect }]
test("fresh-child inspection uses inherited parent permissions in execution order", async () => {
  for (const parent of ["allow", "deny"]) {
    const f = fixture({ permissionFiltered: true, agentPermissions: shell(parent === "allow" ? "deny" : "allow"), parentPermissions: shell(parent) })
    const result = await invoke(f, "subagent_capabilities", { agent: "general" })
    assert.deepEqual(result.metadata.subagentCapabilities.tools, parent === "allow" ? ["shell"] : [])
    const input = { agent: "general", required_tools: ["shell"], background: true, model: "provider/model" }
    if (parent === "deny") await assert.rejects(invoke(f, "subagent", input), /missing required tools: shell/)
    else await invoke(f, "subagent", input)
    assert.equal(f.calls(), parent === "allow" ? 1 : 0)
    assert.deepEqual(f.snapshots[0].rules, [...shell(parent === "allow" ? "deny" : "allow"), ...shell(parent)])
  }
})
test("continuation uses actual child permissions rather than current parent rules", async () => {
  const f = fixture({ permissionFiltered: true, agentPermissions: shell("deny"), parentPermissions: shell("deny"), childPermissions: shell("allow") })
  const result = await invoke(f, "subagent_capabilities", { agent: "general", sessionID: "child" })
  assert.deepEqual(result.metadata.subagentCapabilities.tools, ["shell"])
})
test("stock policy keeps ask and resource-scoped grants visible without authorizing execution", async () => {
  for (const parentPermissions of [
    shell("ask"),
    [{ action: "shell", resource: "git *", effect: "allow" }],
  ]) {
    const f = fixture({ permissionFiltered: true, agentPermissions: shell("deny"), parentPermissions })
    const result = await invoke(f, "subagent_capabilities", { agent: "general" })
    assert.deepEqual(result.metadata.subagentCapabilities.tools, ["shell"])
    assert.equal(result.metadata.subagentCapabilities.approvalMayBeRequired, true)
    assert.equal(result.metadata.subagentCapabilities.authorization, "visibility_only")
  }
})
test("parent lookup failure stops fresh-child inspection and spawning", async () => {
  const f = fixture({ parentMissing: true })
  await assert.rejects(invoke(f, "subagent_capabilities", { agent: "general" }), /Parent session not found/)
  await assert.rejects(invoke(f, "subagent", { agent: "general", required_tools: [] }), /Parent session not found/)
  assert.equal(f.calls(), 0)
  assert.equal(f.snapshots.length, 0)
})
