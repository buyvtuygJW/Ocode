import assert from "node:assert/strict"
import test from "node:test"
import fs from "node:fs"
import { createRequire, registerHooks, stripTypeScriptTypes } from "node:module"
import { fileURLToPath, pathToFileURL } from "node:url"

const local = createRequire(import.meta.url)
const effectURL = process.env.PERSONALIZE_EFFECT ?? pathToFileURL(local.resolve("effect")).href
const { Effect, Stream } = await import(effectURL)
const source = new URL("../../src/config/plugin/mcp.ts", import.meta.url)
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "effect") return { url: effectURL, shortCircuit: true }
    if (specifier === "@opencode/schema/permission-shorthand")
      return { url: new URL("../../../schema/src/permission-shorthand.ts", import.meta.url).href, shortCircuit: true }
    if (context.parentURL === source.href) {
      if (specifier === "@opencode/plugin/effect/plugin") return { url: "fixture:plugin", shortCircuit: true }
      if (specifier === "@opencode/schema/config") return { url: "fixture:document", shortCircuit: true }
      if (specifier === "../../config.js") return { url: "fixture:config", shortCircuit: true }
      if (specifier === "../../mcp/index.js") return { url: "fixture:mcp", shortCircuit: true }
      if (specifier === "./mcp.js") return { url: source.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    const modules = {
      "fixture:plugin": "export const define = value => value",
      "fixture:document": "export class Document {}",
      "fixture:config": 'import {Context} from "effect"; export const Config = {Service:Context.Service("fixture/config")}',
      "fixture:mcp": 'import {Context} from "effect"; export const Mcp = {Service:Context.Service("fixture/mcp")}',
    }
    if (modules[url]) return { format: "module", source: modules[url], shortCircuit: true }
    if (url === source.href || url.endsWith("/permission-shorthand.ts"))
      return { format: "module", source: stripTypeScriptTypes(fs.readFileSync(fileURLToPath(url), "utf8")), shortCircuit: true }
    return next(url, context)
  },
})
const { register } = await import(source.href)
const { Config } = await import("fixture:config")
const { Mcp } = await import("fixture:mcp")
const servers = {
  playwright: { type: "local", command: ["browser"], disabled: true },
  other: { type: "remote", url: "https://example.invalid/mcp", disabled: false },
}
async function run(selection, options = {}) {
  const permissions = [{ action: "shell", resource: "*", effect: "deny" }]
  const entries = [{
    type: "document",
    info: { permissions, mcp: { servers }, ...(selection === undefined ? {} : { experimental: { mcp_selection: selection } }) },
  }, ...(options.entries ?? [])]
  const saved = structuredClone(entries)
  const editor = new Map(options.initial ?? [])
  const writes = []
  const exit = await Effect.runPromiseExit(register(Stream.never).pipe(
    Effect.provideService(Config.Service, { entries: () => Effect.succeed(entries) }),
    Effect.provideService(Mcp.Service, {
      reload: () => Effect.void,
      transform: transform => Effect.sync(() => transform({
        get: name => editor.get(name),
        set: (name, value) => { writes.push(name); editor.set(name, value) },
      })),
    }),
    Effect.scoped,
  ))
  assert.deepEqual(entries, saved, "config and native permissions must remain unmodified")
  return { exit, editor, writes }
}
test("MCP shorthand drives actual config registration and leaves native permissions unchanged", async () => {
  const result = await run("MCP:=playwright")
  assert.equal(result.exit._tag, "Success")
  assert.equal(result.editor.get("playwright").disabled, false)
  assert.equal(result.editor.get("other").disabled, true)
  assert.deepEqual(result.editor.get("playwright").command, ["browser"])
})
test("omission retains existing server availability; highest-priority selection wins", async () => {
  const unchanged = await run(undefined)
  assert.equal(unchanged.editor.get("playwright").disabled, true)
  assert.equal(unchanged.editor.get("other").disabled, false)
  const selected = await run("MCP:=playwright", { entries: [
    { type: "document", info: { experimental: { mcp_selection: "MCP:=other" } } },
  ] })
  assert.equal(selected.editor.get("playwright").disabled, true)
  assert.equal(selected.editor.get("other").disabled, false)
})
test("invalid, unknown, and filesystem policies mutate no server settings", async () => {
  for (const value of ["MCP:=missing", "MCP:=playwright RU=S*", "RU=S*", "ALL:CRUD=D"]) {
    const result = await run(value)
    assert.equal(result.exit._tag, "Failure", value)
    assert.deepEqual(result.writes, [], value)
  }
})
test("configured selection changes availability without replacing plugin server settings", async () => {
  const result = await run("MCP:=playwright", {
    initial: [["other", { type: "local", command: ["plugin-owned"], disabled: false }]],
  })
  assert.equal(result.editor.get("other").disabled, true)
  assert.deepEqual(result.editor.get("other").command, ["plugin-owned"])
})
