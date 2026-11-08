import assert from "node:assert/strict"
import { test } from "node:test"
import { personalizeSystem } from "../packages/core/src/personalize/model-request.ts"

test("system personalization uses text and preserves cache metadata", () => {
  const cache = Object.freeze({ type: "ephemeral" })
  const symbol = Symbol("metadata")
  const first = Object.freeze({ text: "Keep this rule.", cache, [symbol]: "keep" })
  const second = Object.freeze({ text: "Second rule." })
  const result = personalizeSystem([first, second])
  assert.match(result[0].text, /Keep this rule\./)
  assert.equal(Object.hasOwn(result[0], "content"), false)
  assert.equal(result[0].cache, cache)
  assert.equal(result[0][symbol], "keep")
  assert.equal(result[1], second)
  assert.equal(first.text, "Keep this rule.")
})
import { Effect, Stream } from "effect"
import { LLMClient, LanguageModel } from "@opencode/ai/effect"
import { capRequest } from "../packages/core/src/personalize/output-request.ts"
import { capBody, outputCap, outputEffort, OutputGate } from "../packages/core/src/personalize/output-policy.ts"
import { decorate } from "../packages/core/src/personalize/step.ts"
import { fromRequest as chatBody } from "../packages/ai/src/protocols/openai-chat.ts"
import { lowerGeneration as responseBody } from "../packages/ai/src/protocols/open-responses.ts"

function request(effort = "xhigh", patch = {}) {
  const model = LanguageModel.make({ id: "gpt-test", provider: "openai", route: {
    id: "test", endpoint: { baseURL: "https://api.openai.com/v1" },
  }, options: { providerOptions: { reasoningEffort: effort } } })
  return { model, system: [], messages: [], tools: [], maxTokens: 128000, ...patch }
}
const resolved = { ref: {}, limit: { context: 262144, output: 128000 } }
const call = (id = "write-1") => ({ type: "tool-call", id, name: "write", input: { content: "echo ok" } })
const finish = (reason = "tool-calls", type = "step-finish") => ({ type, index: 0, reason: { normalized: reason } })

test("effort output ceilings are 16k/32k/50k/100k and smaller limits win", () => {
  for (const effort of ["none", "minimal", "low", "medium", "default", "custom"])
    assert.equal(outputCap(effort), 16000)
  assert.equal(outputCap("high"), 32000)
  assert.equal(outputCap("xhigh"), 50000)
  assert.equal(outputCap("max", 1000000), 100000)
  assert.equal(outputCap("xhigh", 4096), 4096)
  assert.equal(outputCap("high", 0, undefined, Infinity), 32000)
})

test("actual provider effort beats a variant nickname and handles native option spellings", () => {
  assert.equal(outputEffort({ reasoningEffort: "high" }, "xhigh"), "high")
  assert.equal(outputEffort({ reasoning: { effort: "max" } }), "max")
  assert.equal(outputEffort({ thinkingConfig: { thinkingLevel: "HIGH" } }), "high")
  assert.equal(outputEffort({}, "xhigh"), "xhigh")
})

test("xhigh cap reaches actual Responses and Chat request bodies", async () => {
  const capped = capRequest(request(), resolved)
  assert.equal(responseBody(capped).max_output_tokens, 50000)
  const body = await Effect.runPromise(chatBody(capped))
  assert.equal(body.max_completion_tokens ?? body.max_tokens, 50000)
})

test("generation limits, model output limits and remaining context can only reduce the cap", () => {
  assert.equal(capRequest(request("xhigh", { maxTokens: 2048 }), resolved).maxTokens, 2048)
  assert.equal(capRequest(request(), { ...resolved, limit: { ...resolved.limit, output: 8192 } }).maxTokens, 8192)
  assert.equal(capRequest(request(), resolved, resolved.limit.context - 2024).maxTokens, 1000)
  assert.equal(capRequest(request("max"), resolved).maxTokens, 100000)
})

test("a request without an output limit stays without one (ChatGPT/Codex rejects any)", () => {
  const capped = capRequest(request("xhigh", { maxTokens: undefined }), resolved)
  assert.equal(Object.hasOwn(capped, "maxTokens") && capped.maxTokens !== undefined, false)
  assert.equal(responseBody(capped).max_output_tokens, undefined)
})

test("native HTTP overlays cannot increase the cap or mutate user settings", () => {
  const body = { max_output_tokens: 999999, generationConfig: { maxOutputTokens: 60000 }, untouched: true }
  const original = structuredClone(body)
  assert.deepEqual(capBody(body, 16000), { max_output_tokens: 16000, generationConfig: { maxOutputTokens: 16000 }, untouched: true })
  assert.deepEqual(body, original)
  const capped = capRequest(request("max", { http: { body } }), resolved)
  assert.equal(capped.http.body.max_output_tokens, 100000)
})

test("text streams immediately, but local calls wait for a successful complete response", () => {
  const gate = new OutputGate(), a = call(), b = call("write-2")
  const text = { type: "text-delta", id: "text", text: "working" }
  assert.deepEqual(gate.push(text), [text])
  assert.deepEqual(gate.push(a), [])
  assert.deepEqual(gate.push(b), [])
  assert.deepEqual(gate.push(finish()), [])
  assert.deepEqual(gate.end(), [a, b, finish()])
  assert.equal(gate.rejected, undefined)
})

test("length truncation discards all pending local calls, retaining usage finish events", () => {
  const gate = new OutputGate()
  gate.push(call())
  const end = { ...finish("length"), usage: { outputTokens: 50000 } }
  gate.push(end)
  assert.deepEqual(gate.end(), [end])
  assert.equal(gate.rejected, "length")
})

test("missing finish, malformed input and provider errors fail closed", () => {
  for (const bad of [undefined, { type: "tool-input-error", id: "write-1", name: "write", raw: '{"content":' },
    { type: "provider-error", error: new Error("cut off") }]) {
    const gate = new OutputGate()
    gate.push(call())
    if (bad) gate.push(bad)
    if (bad) gate.push(finish())
    assert.ok(!gate.end().some((x) => x.type === "tool-call"))
    assert.ok(gate.rejected)
  }
})

test("provider-executed events pass through; duplicate local calls are not deduplicated", () => {
  const gate = new OutputGate(), remote = { ...call(), providerExecuted: true }
  assert.deepEqual(gate.push(remote), [remote])
  gate.push(call()); gate.push(call()); gate.push(finish())
  assert.equal(gate.end().filter((x) => x.type === "tool-call").length, 2)
})

// Host runner/client stand-ins; the actual owned wrapper and real Effect
// stream perform the safety decision. No tools, servers or API calls execute.
async function run(events, outcome = { _tag: "Completed" }) {
  const executed = [], timeline = []
  let attempts = 0
  const stock = { make: Effect.gen(function* () {
    const client = yield* LLMClient.Service
    return { attempt: () => Effect.gen(function* () {
      attempts++
      yield* client.stream(request()).pipe(Stream.runForEach((event) => Effect.sync(() => {
        timeline.push(event.type)
        if (event.type === "tool-call") executed.push(event)
      })))
      return outcome
    }) }
  }) }
  const program = decorate(stock).make.pipe(Effect.flatMap((service) => service.attempt({})),
    Effect.provideService(LLMClient.Service, { stream: () => Stream.fromArray(events) }))
  const exit = await Effect.runPromise(Effect.exit(program))
  return { exit, executed, attempts, timeline }
}

test("truncated response never executes the write and never retries the model", async () => {
  const result = await run([call(), finish("length")], { _tag: "OutputLimit", needsContinuation: true })
  assert.equal(result.exit._tag, "Failure")
  assert.equal(result.attempts, 1)
  assert.deepEqual(result.executed, [])
})

test("normal multiple tool calls survive the guard in their original order", async () => {
  const a = call(), b = call("write-2")
  const result = await run([a, b, finish()])
  assert.equal(result.exit._tag, "Success")
  assert.deepEqual(result.executed, [a, b])
  assert.equal(result.attempts, 1)
})

test("pure text output-limit also stops instead of triggering stock auto-continuation", async () => {
  const result = await run([finish("length")], { _tag: "OutputLimit", needsContinuation: false })
  assert.equal(result.exit._tag, "Failure")
  assert.equal(result.attempts, 1)
})
