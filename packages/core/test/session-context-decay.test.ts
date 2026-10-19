import { expect, test } from "bun:test"
import { SessionMessage } from "@opencode/schema/session-message"
import {
  ARCHIVE_AFTER_TURNS,
  REEVAL_QUANTUM,
  decay,
  indexBlock,
} from "@opencode/core/session/runner/context-decay"
import { Schema } from "effect"

// ------------------------------------------------------------------------------------------------- fixtures

let counter = 0
const callID = () => `call_${counter++}`

const user = (text: string) =>
  Schema.decodeUnknownSync(SessionMessage.User)({
    id: SessionMessage.ID.create(),
    type: "user",
    text,
    time: { created: 0 },
  })

const assistant = (content: readonly unknown[]) =>
  Schema.decodeUnknownSync(SessionMessage.Assistant)({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: "build", // Agent.defaultID — decode validates it against the Agent.ID brand

    model: { id: "test-model", providerID: "test" },
    content,
    time: { created: 0, completed: 0 },
  })

const tool = (state: Record<string, unknown>, id = callID()) => ({
  type: "tool",
  id,
  name: "read",
  state,
  time: { created: 0 },
})

const text = (value: string) => ({ type: "text", text: value })

const err = { type: "unknown", message: "tool blew up" }

/** Every tool part in a projected history, across every assistant message. */
const toolsOf = (messages: readonly SessionMessage.Info[]) =>
  messages.flatMap((message) =>
    message.type === "assistant"
      ? message.content.filter((item): item is SessionMessage.AssistantTool => item.type === "tool")
      : [],
  )

/**
 * The exact read compaction/lowering performs on a tool result. This is the line that crashed in production
 * (`e.content.map` on an error state that carried no content) — it must never see `undefined` on a completed
 * state and must never be handed an emptied array on a rewritten one.
 */
const compactionRead = (state: SessionMessage.ToolState) => {
  if (state.status === "completed") return state.content.map((part) => ("text" in part ? part.text : "")).join("\n")
  if (state.status === "error") return (state.content ?? []).map((part) => ("text" in part ? part.text : "")).join("\n")
  return ""
}

// ----------------------------------------------------------------------------------------------------- tests

test("reader survives every tool state — including an error state with no content", () => {
  const noContentID = callID()
  const messages = [
    user("please read the file"),
    assistant([
      text("running the tools"),
      tool({ status: "streaming", input: '{"filePath": "D:/tmp/a' }),
      tool({ status: "running", input: { filePath: "D:/tmp/a/x.ts" }, metadata: {} }),
      tool({ status: "completed", input: {}, content: [text("short output")] }),
      tool({ status: "error", input: {}, error: err, content: [text("stack trace")] }),
      // The regression: ToolStateError.content is optional — V2 rows can legally omit it entirely.
      tool({ status: "error", input: {}, error: err }, noContentID),
    ]),
  ]

  expect(() => decay(messages)).not.toThrow()
  const result = decay(messages)

  for (const item of toolsOf(result.messages)) {
    // The reader itself must come back as a string for every state, never undefined, never a throw.
    expect(() => compactionRead(item.state)).not.toThrow()
    expect(typeof compactionRead(item.state)).toBe("string")
    // Completed content is a NonEmptyArray in the schema; decay must never have emptied or dropped it.
    if (item.state.status === "completed") {
      expect(Array.isArray(item.state.content)).toBe(true)
      expect(item.state.content.length).toBeGreaterThan(0)
    }
    // Error content stays either absent (untouched) or a non-empty array — never null, never [].
    if (item.state.status === "error" && item.state.content !== undefined) {
      expect(item.state.content.length).toBeGreaterThan(0)
    }
  }

  // The no-content error tool passed through untouched: no fabricated body, no crash, content still absent.
  const untouched = toolsOf(result.messages).find((item) => item.id === noContentID)
  expect(untouched).toBeDefined()
  expect(untouched!.state.status).toBe("error")
  expect((untouched!.state as SessionMessage.ToolStateError).content).toBeUndefined()
})

test("archived tools keep a non-empty marker — content is never emptied or undefined", () => {
  const big = "x".repeat(5_000)
  const oldCompleted = callID()
  const oldErrored = callID()

  const history: SessionMessage.Info[] = [
    user("task one"),
    assistant([
      text("reading the big files"),
      tool({ status: "completed", input: { filePath: "D:/tmp/a/big.ts" }, content: [text(big)] }, oldCompleted),
      tool({ status: "error", input: { filePath: "D:/tmp/a/gone.ts" }, error: err, content: [text(big)] }, oldErrored),
    ]),
  ]
  // Push the first turns behind the archive frontier: frontier = quantize(length - ARCHIVE_AFTER_TURNS) >= 2.
  const padding = ARCHIVE_AFTER_TURNS + REEVAL_QUANTUM * 2
  for (let i = 0; i < padding; i++) history.push(user(`filler turn ${i}`), assistant([text(`noted ${i}`)]))

  const result = decay(history)
  expect(result.rewritten).toBe(true)
  expect(result.archive.length).toBeGreaterThanOrEqual(2)

  const byID = new Map(toolsOf(result.messages).map((item) => [item.id, item]))
  for (const id of [oldCompleted, oldErrored]) {
    const item = byID.get(id)!
    expect(item).toBeDefined()
    const state = item.state as SessionMessage.ToolStateCompleted | SessionMessage.ToolStateError
    // Never emptied outright — an empty tool result trips provider tool_call/tool_result pairing checks,
    // and an undefined one is exactly the `e.content.map` crash this test pins down.
    expect(Array.isArray(state.content)).toBe(true)
    expect(state.content!.length).toBeGreaterThan(0)
    const body = compactionRead(state)
    expect(body).toMatch(/^\[archived — ref .+\]$/)
    expect(body.length).toBeGreaterThan(0)
  }

  // Every surviving tool in the whole history still reads cleanly through the compaction path.
  for (const item of toolsOf(result.messages)) {
    expect(typeof compactionRead(item.state)).toBe("string")
  }

  // The index block mirrors the archive and stays a plain string.
  const block = indexBlock(result.archive)
  expect(block).toBeDefined()
  expect(block!).toContain(`count="${result.archive.length}"`)
  expect(indexBlock([])).toBeUndefined()
})

test("content-less V2 variants (idle, compaction, marker turns) pass through decay untouched — no crash, no fabricated content", () => {
  // The production crash: `undefined is not an object (evaluating 'e.content.map')` inside SessionCompaction.compact.
  // V2 `Info` is an 11-variant union and these variants have NO `content` field and NO `role` field at all.
  const idle = Schema.decodeUnknownSync(SessionMessage.Info)({
    id: SessionMessage.ID.create(),
    type: "idle",
    outcome: "succeeded",
    time: { created: 0 },
  })
  const compaction = Schema.decodeUnknownSync(SessionMessage.Info)({
    id: SessionMessage.ID.create(),
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary: "compacted earlier work",
    recent: "recent tail",
    time: { created: 0 },
  })

  const toolID = callID()
  const messages = [
    user("do the thing"),
    assistant([text("on it"), tool({ status: "completed", input: {}, content: [text("ok")] }, toolID)]),
    idle,
    compaction,
    user("next task"),
  ]

  // Must not throw on any variant, with or without a prior key.
  expect(() => decay(messages)).not.toThrow()
  const result = decay(messages)
  expect(() => decay(result.messages, result.key)).not.toThrow()

  // Markers come back as the exact same references — decay never rewrites, clones, or invents `content` on them.
  expect(result.messages).toHaveLength(messages.length)
  expect(result.messages[2]).toBe(idle)
  expect(result.messages[3]).toBe(compaction)
  expect("content" in result.messages[2]!).toBe(false)
  expect("content" in result.messages[3]!).toBe(false)

  // The assistant turn's tool still reads cleanly through the compaction path.
  const item = toolsOf(result.messages).find((entry) => entry.id === toolID)!
  expect(item).toBeDefined()
  expect(typeof compactionRead(item.state)).toBe("string")
})

test("short-circuit hands back identical references, not re-read copies", () => {
  const messages = [
    user("hello"),
    assistant([text("done"), tool({ status: "completed", input: {}, content: [text("ok")] })]),
  ]
  const first = decay(messages)
  const second = decay(first.messages, first.key)
  expect(second.rewritten).toBe(false)
  expect(second.messages).toBe(first.messages)
  expect(second.archive).toEqual([])
})

test("mixed text and file parts read without crashing and short output is left verbatim", () => {
  const mixedID = callID()
  const messages = [
    user("read the image"),
    assistant([
      text("reading"),
      tool(
        {
          status: "completed",
          input: {},
          content: [text("tiny"), { type: "file", mime: "image/png", uri: "data:image/png;base64,QUJD" }],
        },
        mixedID,
      ),
    ]),
  ]
  const result = decay(messages)
  const item = toolsOf(result.messages).find((entry) => entry.id === mixedID)!
  const state = item.state as SessionMessage.ToolStateCompleted
  // Too short to be worth touching: body, including the non-text part, survives byte-identical.
  expect(state.content.length).toBe(2)
  expect(() => compactionRead(state)).not.toThrow()
})
