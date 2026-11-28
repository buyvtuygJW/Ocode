import assert from "node:assert/strict"
import { test } from "node:test"
import { decorate } from "../packages/client/src/personalize/connection.ts"

const bootError = () => new Error("Background service failed to start")
const turns = async () => { await Promise.resolve(); await Promise.resolve() }

test("failed service retries back off, cap at 30 seconds, reset on success and preserve errors", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let forwarded, calls = 0, error = bootError()
  const stock = { createClientConnection: (_api, options) => { forwarded = options; return "connection" } }
  const wrapped = decorate(stock)
  const api = {}
  assert.equal(wrapped.createClientConnection(api, {
    onEvent() {}, reconnect: async () => { calls++; if (error) throw error; return api },
  }), "connection")
  const signal = new AbortController().signal
  await assert.rejects(forwarded.reconnect(signal), (value) => value === error)
  for (const delay of [2000, 4000, 8000, 16000, 30000, 30000]) {
    const before = calls
    const pending = assert.rejects(forwarded.reconnect(signal), (value) => value === error)
    t.mock.timers.tick(delay - 1)
    await turns()
    assert.equal(calls, before)
    t.mock.timers.tick(1)
    await pending
    assert.equal(calls, before + 1)
  }
  error = undefined
  const pending = forwarded.reconnect(signal)
  t.mock.timers.tick(30000)
  assert.equal(await pending, api)
  const before = calls
  assert.equal(await forwarded.reconnect(signal), api)
  assert.equal(calls, before + 1)
})

test("cancellation interrupts the cooldown without another resolver call; unrelated errors do not back off", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  let forwarded, calls = 0, error = bootError()
  decorate({ createClientConnection: (_api, options) => { forwarded = options } }).createClientConnection({}, {
    onEvent() {}, reconnect: async () => { calls++; throw error },
  })
  await assert.rejects(forwarded.reconnect(new AbortController().signal), /failed to start/)
  const abort = new AbortController()
  const pending = assert.rejects(forwarded.reconnect(abort.signal), /cancelled/)
  abort.abort(new Error("cancelled"))
  await pending
  assert.equal(calls, 1)
  error = new Error("ordinary transient network failure")
  const next = assert.rejects(forwarded.reconnect(new AbortController().signal), (value) => value === error)
  t.mock.timers.tick(2000)
  await next
  await assert.rejects(forwarded.reconnect(new AbortController().signal), (value) => value === error)
  assert.equal(calls, 3)
})
