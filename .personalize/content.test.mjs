import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { canonicalMessages, historyMessages, copyWith } from "../packages/core/src/personalize/content.ts"
import { personaLead, stripStockIdentity } from "../packages/core/src/personalize/persona.ts"

test("valid messages retain their exact object identity and metadata", () => {
  const message = { role: "user", content: [{ type: "text", text: "hello" }], metadata: { instruction: [1] } }
  assert.equal(canonicalMessages([message])[0], message)
})

test("missing content is repaired without losing prototypes, symbols, readonly or hidden metadata", () => {
  const marker = Symbol("metadata")
  class Message { content = undefined; role = "user"; get kind() { return "original" } }
  const message = new Message()
  Object.defineProperty(message, marker, { value: { instructions: [1] }, enumerable: false })
  Object.defineProperty(message, "content", { value: undefined, writable: false, enumerable: true })
  const result = canonicalMessages([message])[0]
  assert(result instanceof Message)
  assert.equal(result.kind, "original")
  assert.equal(result[marker], message[marker])
  assert.equal(Object.getOwnPropertyDescriptor(result, marker).enumerable, false)
  assert.equal(Object.getOwnPropertyDescriptor(result, "content").writable, false)
  assert.deepEqual(result.content, [])
  assert.equal(message.content, undefined)
})

test("nullish arrays and tool-result values are repaired, not mutated", () => {
  assert.deepEqual(canonicalMessages(undefined), [])
  const message = { role: "tool", content: [{ type: "tool-result", result: { type: "content", value: undefined } }] }
  const result = canonicalMessages([message])[0]
  assert.deepEqual(result.content[0].result.value, [])
  assert.equal(message.content[0].result.value, undefined)
})

test("history repair keeps completed-tool metadata and leaves healthy records alone", () => {
  const good = { role: "assistant", content: [] }
  assert.equal(historyMessages([good])[0], good)
  const bad = { role: "assistant", content: [{ type: "tool", state: { status: "completed", content: undefined, metadata: { id: 1 } } }] }
  const result = historyMessages([bad])[0]
  assert.deepEqual(result.content[0].state.content, [])
  assert.equal(result.content[0].state.metadata, bad.content[0].state.metadata)
})

test("system-part replacement preserves instruction/cache metadata", () => {
  const part = { content: "stock", metadata: { experimental: { instructions: [{ id: 1 }] } } }
  const result = copyWith(part, { content: "persona\nstock" })
  assert.equal(result.metadata, part.metadata)
  assert.equal(part.content, "stock")
})

test("persona seeds the existing role schema and reads only assistant_system", () => {
  const root = path.join(tmpdir(), "opencode")
  mkdirSync(root, { recursive: true })
  const directory = mkdtempSync(path.join(root, "personalize-role-"))
  const previous = process.env.OPENCODE_ROLE_FILE
  try {
    const file = path.join(directory, "role.json")
    process.env.OPENCODE_ROLE_FILE = file
    assert.equal(personaLead(), "")
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { usersystem: "", assistant_system: "" })
    writeFileSync(file, JSON.stringify({ usersystem: "not this", assistant_system: "exact persona" }))
    assert.equal(personaLead(), "exact persona")
    writeFileSync(file, "{broken")
    assert.equal(personaLead(), "")
    assert.equal(stripStockIdentity("You are OpenCode, a coding assistant. Keep tools."), "Keep tools.")
    assert.equal(stripStockIdentity("You are opencode, an agent of change."), "You are opencode, an agent of change.")
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_ROLE_FILE
    else process.env.OPENCODE_ROLE_FILE = previous
    rmSync(directory, { recursive: true, force: true })
  }
})
