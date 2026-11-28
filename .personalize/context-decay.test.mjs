import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { stripTypeScriptTypes } from "node:module"
import { AsyncLocalStorage } from "node:async_hooks"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

// Load the actual owned bodies, replacing only their import boundaries.
function load(file, deps, names) {
  let source = stripTypeScriptTypes(readFileSync(new URL(file, import.meta.url), "utf8"))
  source = source.replace(/^import \{([^}]+)\} from ["']([^"']+)["'];?\s*$/gm,
    (_, names, specifier) => `const {${names}} = deps[${JSON.stringify(specifier)}];`)
    .replace(/^export /gm, "")
  return new Function("deps", `${source}\nreturn {${names.join(",")}}`)(deps)
}
const decayModule = load("../packages/core/src/session/runner/context-decay.ts", { "../message.js": {} }, ["decay", "indexBlock"])
const content = load("../packages/core/src/personalize/content.ts", {}, ["historyMessages"])
const policy = load("../packages/core/src/personalize/decay-policy.ts", { "node:async_hooks": { AsyncLocalStorage } }, ["withDecayPolicy", "rememberDecayBypass", "bypassDecay"])
const { decorate } = load("../packages/core/src/personalize/to-llm-message.ts", {
  "@opencode/ai/effect": { Message: { user: (text) => ({ type: "index", text }) } },
  "../session/runner/context-decay": decayModule,
  "./content": content,
  "./decay-policy": policy,
}, ["decorate"])
const lower = decorate({ toLLMMessages: (messages) => [...messages] }).toLLMMessages
const tool = (id, body, extra = {}) => ({ type: "assistant", content: [{
  type: "tool", id, name: "read", state: { status: "completed", input: {}, content: [{ type: "text", text: body }], ...extra },
}] })
const body = (message) => message.content[0].state.content[0].text
const user = (text) => ({ type: "user", text })

test("append stability, changed results, independent histories and bypass", () => {
  const large = "abc".repeat(20000)
  const first = tool("one", large), second = tool("two", large)
  const before = lower([first])
  const after = lower([first, second])
  assert.equal(body(before[0]), large)
  assert.equal(body(after[0]), large)
  assert.match(body(after[1]), /earlier tool result "one"/)
  assert.match(after[2].text, /no automatic retrieval/)
  const edited = lower([first, tool("two", large + "changed")])
  assert.equal(body(edited[1]), large + "changed")
  const streaming = { type: "assistant", content: [{ type: "tool", id: "two", name: "read", state: { status: "streaming", input: "{" } }] }
  assert.deepEqual(lower([first, streaming])[1], streaming)
  assert.match(body(lower([first, second])[1]), /earlier tool result/)
  assert.equal(body(lower([tool("two", large)])[0]), large)
  const model = policy.rememberDecayBypass({}, true)
  assert.equal(body(policy.withDecayPolicy(model, () => lower([first, second]))[1]), large)
})

test("frontier retires only recoverable duplicates, including with an unchanged previous key", () => {
  const large = "z".repeat(5000)
  const history = [tool("first", large), tool("copy", large), tool("unique", "u".repeat(90000))]
  const before = decayModule.decay(history)
  assert.equal(before.archive.length, 0)
  const after = decayModule.decay([...history, ...Array.from({ length: 30 }, (_, i) => user(`filler ${i}`))], before.key)
  assert.equal(after.archive.length, 1)
  assert.match(body(after.messages[1]), /earlier tool result "first"/)
  assert.equal(body(after.messages[2]), "u".repeat(90000))
  assert.notEqual(after.key.frontier, before.key.frontier)
  const changed = decayModule.decay([history[0], tool("copy", "changed")], before.key)
  assert.equal(body(changed.messages[1]), "changed")
})

test("unverified paths, mixed media, errors and repeated ids are never treated as recovery", () => {
  const large = "v".repeat(90000)
  const mixed = tool("mixed", large)
  mixed.content[0].state.content.push({ type: "file", uri: "data:fixture", mime: "image/png" })
  const inputs = [
    tool("path", large, { outputPaths: ["C:/unverified"], metadata: { outputPath: "C:/unverified", truncated: true } }),
    mixed,
    { type: "assistant", content: [{ type: "tool", id: "error", name: "x", state: { status: "error", input: {}, content: [{ type: "text", text: large + "error" }] } }] },
    tool("same", large), tool("same", large),
  ]
  const result = decayModule.decay(inputs)
  assert.deepEqual(result.messages, inputs)
  assert.deepEqual(result.archive, [])
})

test("task changes reallocate budgets but never discard unique evidence", () => {
  const large = "t".repeat(12000)
  const inProject = (id, text, file) => tool(id, text, { input: { filePath: file } })
  const first = inProject("first", large, "C:/alpha/work/a")
  const duplicate = inProject("duplicate", large, "C:/alpha/work/b")
  const initial = [first, duplicate, user("alpha task")]
  assert.equal(decayModule.decay(initial).archive.length, 0)
  const shifted = [...initial, inProject("other", "unique", "D:/beta/work/a"),
    inProject("other2", "unique two", "D:/beta/work/b"), user("beta task")]
  const result = decayModule.decay(shifted)
  assert.ok(result.key.segment > 0)
  assert.match(body(result.messages[1]), /earlier tool result "first"/)
  assert.equal(body(result.messages[3]), "unique")
})

test("a result in a failed assistant turn is not used as a recovery source", () => {
  const large = "q".repeat(90000)
  const failed = { ...tool("discarded", large), error: { type: "unknown" } }
  const result = decayModule.decay([failed, tool("later", large)])
  assert.equal(body(result.messages[1]), large)
  assert.equal(result.archive.length, 0)
})

const localLowering = new URL("../packages/core/src/session/runner/to-llm-message.ts", import.meta.url)
const stockSource = existsSync(localLowering) ? localLowering
  : process.env.PERSONALIZE_TEST_UPSTREAM && pathToFileURL(path.join(
    process.env.PERSONALIZE_TEST_UPSTREAM, "packages/core/src/session/runner/to-llm-message.ts",
  ))

test("duplicate anchors survive actual upstream history lowering", async () => {
  assert.ok(stockSource, "Set PERSONALIZE_TEST_UPSTREAM when testing owned sources without stock history lowering")
  // Bun loads the complete real dependency graph, including newly introduced
  // compaction renderers. No import doubles can conceal upstream contract drift.
  const owned = new URL("../packages/core/src/personalize/to-llm-message.ts", import.meta.url)
  const result = spawnSync(process.env.PERSONALIZE_TEST_BUN ?? "bun", ["--eval", `
    const stock = await import(${JSON.stringify(stockSource.href)});
    const { decorate } = await import(${JSON.stringify(owned.href)});
    const wrapped = decorate(stock).toLLMMessages;
    const tool = ${tool.toString()};
    const model = { providerID: "test", id: "model" };
    const large = "original-evidence".repeat(6000);
    const completed = (id) => {
      const message = { ...tool(id, large), id: "message-" + id, model, finish: "tool-calls" };
      message.content[0].time = { ran: 0 };
      return message;
    };
    const first = completed("original"), second = completed("duplicate");
    const parts = (messages) => messages.flatMap((message) => message.content)
      .filter((part) => part.type === "tool-result");
    const before = parts(wrapped([first], model));
    const after = parts(wrapped([first, second], model));
    const failed = { ...first, error: { type: "unknown" },
      content: first.content.map((part) => ({ ...part, executed: true })) };
    const withoutAnchor = parts(wrapped([failed, second], model));
    console.log(JSON.stringify({ before, after, withoutAnchor }));
  `], { encoding: "utf8", timeout: 30000, maxBuffer: 2 * 1024 * 1024 })
  assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}`)
  const { before, after, withoutAnchor } = JSON.parse(result.stdout)
  assert.deepEqual(after[0], before[0], "appending a duplicate must not change the retained result")
  assert.equal(after[0].result.value, "original-evidence".repeat(6000))
  assert.match(after[1].result.value, /earlier tool result "original"/)
  assert.equal(withoutAnchor.length, 1, "stock drops the failed hosted call")
  assert.equal(withoutAnchor[0].result.value, "original-evidence".repeat(6000),
    "the remaining result must retain the unique evidence")
})
