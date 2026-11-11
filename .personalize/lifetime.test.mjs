import assert from "node:assert/strict"
import { test } from "node:test"
import { Lifetime, WakeGate, defaults, duration } from "../packages/util/src/personalize-lifetime.ts"

function clock(settings = defaults) {
  let now = 0
  const policy = new Lifetime({ ...settings }, () => now)
  policy.start()
  return { policy, at: (time) => { now = time } }
}

test("defaults are hard 20s / soft 10s", () => {
  assert.deepEqual(defaults, { hardMs: 20_000, softMs: 10_000 })
})

test("duration accepts short custom times and rejects disabling/invalid input", () => {
  for (const [input, ms] of [["1s", 1000], ["50ms", 50], ["0.5s", 500], ["2m", 120000], ["default", 20000]])
    assert.equal(duration(input, 20000), ms)
  for (const input of ["0s", "-1s", "1", "Infinitys", "1s garbage", "0.1ms", "999999999m"])
    assert.throws(() => duration(input, 20000))
})

test("last window disconnect, not heartbeats, starts the hard countdown", () => {
  const { policy, at } = clock({ hardMs: 1000, softMs: 10000 })
  const first = policy.connect(), second = policy.connect()
  policy.work()
  at(5000); first()
  assert.equal(policy.next(), undefined)
  at(9000); second()
  assert.deepEqual(policy.next(), { kind: "hard", after: 1000 })
  at(10000)
  assert.deepEqual(policy.next(), { kind: "hard", after: 0 })
})

test("hard deadline never waits for tasks, subagents, or soft shutdown", () => {
  const { policy, at } = clock({ hardMs: 1000, softMs: 10000 })
  policy.work(); policy.work(); policy.work("requests")
  at(1000)
  assert.deepEqual(policy.next(), { kind: "hard", after: 0 })
})

test("soft never stops the service while a window stays connected", () => {
  const { policy, at } = clock({ hardMs: 20000, softMs: 1000 })
  const close = policy.connect()
  const parent = policy.work(), child = policy.work(), tool = policy.work()
  at(4000); parent(); child()
  assert.equal(policy.next(), undefined)
  at(5000); tool()
  assert.equal(policy.next(), undefined, "an idle open window keeps the service alive")
  at(6000); close()
  assert.deepEqual(policy.next(), { kind: "soft", after: 10000 })
})

test("new work cancels and completion resets the soft countdown", () => {
  const { policy, at } = clock({ hardMs: 20000, softMs: 1000 })
  const close = policy.connect()
  at(900); const done = policy.work()
  at(5000); assert.equal(policy.next(), undefined)
  done(); close()
  assert.deepEqual(policy.next(), { kind: "soft", after: 10000 })
})

test("idle disconnect gets half the hard timeout to reconnect", () => {
  const { policy, at } = clock()
  const close = policy.connect()
  at(30000); close()
  assert.deepEqual(policy.next(), { kind: "soft", after: 10000 })
  at(39999); assert.deepEqual(policy.next(), { kind: "soft", after: 1 })
  const reconnect = policy.connect()
  at(40001); assert.equal(policy.next(), undefined)
  reconnect()
  assert.deepEqual(policy.next(), { kind: "soft", after: 10000 })
})

test("grace starts only when the last window disconnects", () => {
  const { policy, at } = clock({ hardMs: 12000, softMs: 1000 })
  const first = policy.connect(), second = policy.connect()
  at(30000); first()
  assert.equal(policy.next(), undefined)
  at(31000); second()
  assert.deepEqual(policy.next(), { kind: "soft", after: 6000 })
  at(37000); assert.deepEqual(policy.next(), { kind: "soft", after: 0 })
})

test("active work blocks soft shutdown but not the original hard deadline", () => {
  const { policy, at } = clock({ hardMs: 12000, softMs: 1000 })
  const close = policy.connect(), done = policy.work()
  at(30000); close()
  assert.deepEqual(policy.next(), { kind: "hard", after: 12000 })
  at(37000); done()
  assert.deepEqual(policy.next(), { kind: "soft", after: 1000 })
  const again = policy.work()
  at(42000); assert.deepEqual(policy.next(), { kind: "hard", after: 0 })
  again()
})

test("half-hard grace preserves longer soft deadlines and hard priority", () => {
  const { policy, at } = clock({ hardMs: 1000, softMs: 750 })
  assert.deepEqual(policy.next(), { kind: "soft", after: 750 })
  at(100); policy.configure({ hardMs: 1000, softMs: 1000 })
  assert.deepEqual(policy.next(), { kind: "hard", after: 1000 })
  at(200); policy.configure({ hardMs: 1000, softMs: 2000 })
  assert.deepEqual(policy.next(), { kind: "hard", after: 1000 })
})

test("startup and odd millisecond hard timeouts get the half-hard minimum", () => {
  const { policy } = clock({ hardMs: 1001, softMs: 100 })
  assert.deepEqual(policy.next(), { kind: "soft", after: 500.5 })
})

test("a window reconnect cancels the hard countdown without touching soft work state", () => {
  const { policy, at } = clock({ hardMs: 1000, softMs: 10000 })
  policy.work()
  at(999); policy.connect()
  at(1001); assert.equal(policy.next(), undefined)
})

test("soft may stop sooner, hard wins equal deadlines", () => {
  const { policy } = clock()
  assert.deepEqual(policy.next(), { kind: "soft", after: 10000 })
  policy.configure({ hardMs: 1000, softMs: 1000 })
  assert.deepEqual(policy.next(), { kind: "hard", after: 1000 })
})

test("custom settings reset the deadline and finalizers are idempotent", () => {
  const { policy, at } = clock()
  const close = policy.connect(), done = policy.work()
  close(); close(); done(); done()
  assert.equal(policy.clients, 0); assert.equal(policy.jobs, 0)
  at(30000); policy.configure({ hardMs: 1000, softMs: 2000 })
  assert.deepEqual(policy.next(), { kind: "hard", after: 1000 })
})

test("no shutdown during boot or after stopping", () => {
  const policy = new Lifetime()
  assert.equal(policy.next(), undefined)
  policy.start(); policy.stopped = true
  assert.equal(policy.next(), undefined)
})

test("broken soft probe and hung soft cleanup cannot cancel the hard deadline", () => {
  const { policy, at } = clock()
  policy.externalBusy = () => { throw new Error("probe failed") }
  assert.deepEqual(policy.next(), { kind: "hard", after: 20000 })
  policy.externalBusy = () => false
  policy.softStopping = true
  at(20000)
  assert.deepEqual(policy.next(), { kind: "hard", after: 0 })
})

test("intentional sleep parks automatic reconnect until user input", async () => {
  let now = 0, slept = -1
  const gate = new WakeGate((time) => slept > time, () => now)
  const abort = new AbortController()
  await gate.wait(abort.signal)
  now = slept = 1000
  let connected = false
  const reconnect = gate.wait(abort.signal).then(() => { connected = true })
  await Promise.resolve()
  assert.equal(connected, false, "SSE retries cannot wake a sleeping service")
  now = 1100; gate.wake()
  await reconnect
  assert.equal(connected, true)
  await gate.wait(abort.signal)
})

test("parked reconnect is aborted cleanly when its window exits", async () => {
  let slept = -1
  const gate = new WakeGate((time) => slept > time, () => 0)
  const abort = new AbortController()
  slept = 1000
  const reconnect = gate.wait(abort.signal)
  abort.abort(new Error("window closed"))
  await assert.rejects(reconnect, /window closed/)
  gate.wake()
})
