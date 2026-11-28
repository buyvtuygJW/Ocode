import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const root = process.env.PERSONALIZE_SOURCE ?? fileURLToPath(new URL("../", import.meta.url))
const source = (file) => JSON.stringify(path.join(root, file).replaceAll("\\", "/"))
const require = createRequire(path.join(root, "packages/core/package.json"))
const effect = JSON.stringify(require.resolve("effect").replaceAll("\\", "/"))
const nodeServices = JSON.stringify(require.resolve("@effect/platform-node").replaceAll("\\", "/"))
const net = JSON.stringify(require.resolve("effect/net").replaceAll("\\", "/"))

test("delivered seams keep acquisition interruptible and real clients bounded without false readiness", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "opencode-startup-recovery-"))
  for (const part of ["home", "tmp", "state", "config", "data", "cache"])
    mkdirSync(path.join(directory, part))
  try {
    const entry = path.join(directory, "regression.ts")
    writeFileSync(entry, `
      import assert from "node:assert/strict"
      import fs from "node:fs"
      import os from "node:os"
      import path from "node:path"
      import { Effect, Fiber } from ${effect}
      import { NodeServices } from ${nodeServices}
      import { NetAddress } from ${net}
      import { acquireBootLock } from ${source("packages/util/src/personalize-boot-lock.ts")}
      import { withBootLock, PersonalizeBoot } from ${source("packages/util/src/personalize-boot.ts")}
      import { publishStartup, isStarting, startupGraceMs } from ${source("packages/util/src/personalize-startup-state.ts")}
      import * as promiseClient from ${source("packages/client/src/promise/service.ts")}
      import * as effectClient from ${source("packages/client/src/effect/service.ts")}
      import { withEnsureTiming, defaultEnsureTiming } from ${source("packages/client/src/service-timing.ts")}
      import { probeResult, decide } from ${source("packages/client/src/service-probe.ts")}
      import { make as makeStatus } from ${source("packages/server/src/service-status.ts")}
      import { decorate as registerFactory } from ${source("packages/cli/src/personalize/service-registration.ts")}
      const key = "effect-cancellation-" + process.pid
      const held = await acquireBootLock(key)
      let entered = false
      const at = performance.now()
      try {
        await assert.rejects(Effect.runPromise(withBootLock(key, () => Effect.sync(() => { entered = true }))
          .pipe(Effect.timeout("50 millis"))))
        assert.equal(entered, false)
        assert.ok(performance.now() - at < 1500, "Effect acquisition must not mask cancellation for 90s")
      } finally { held.release() }
      for (let i = 0; i < 25; i++) {
        const fiber = Effect.runFork(withBootLock(key, () => Effect.never))
        if (i % 2) await new Promise(r => setTimeout(r, 1))
        await Effect.runPromise(Fiber.interrupt(fiber))
        const next = await acquireBootLock(key, { timeoutMs: 200 })
        next.release()
      }
      await assert.rejects(Effect.runPromise(withBootLock(key, () => Effect.fail(new Error("boot failed")))), /boot failed/)
      ;(await acquireBootLock(key, { timeoutMs: 200 })).release()
      for (const terminal of ["ready", "fail"]) {
        let released = 0
        const boot = { retry: Effect.void, release: Effect.sync(() => { released++ }) }
        await Effect.runPromise(Effect.gen(function* () {
          const state = yield* makeStatus()
          yield* boot.retry
          assert.equal((yield* state.current).type, "retrying")
          yield* state[terminal]
          assert.equal((yield* state.current).type, terminal === "fail" ? "failed" : "ready")
          assert.equal(released, 1)
        }).pipe(Effect.provideService(PersonalizeBoot, boot)))
      }
      // Exercise the registration adapter without replacing the stock signature.
      let published, called = false
      const options = { id: "registration-generation", password: "test-password",
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 1), file: "unused", shutdown: Effect.void }
      const cleanup = Effect.void
      const wrapped = registerFactory({ register: supplied => Effect.sync(() => {
        assert.equal(supplied, options); assert.ok(published); called = true; return cleanup
      }) })
      const returned = await Effect.runPromise(wrapped.register(options).pipe(
        Effect.provideService(PersonalizeBoot, { retry: Effect.void, release: Effect.void,
          register: info => { published = info } })))
      assert.equal(called, true); assert.equal(returned, cleanup)
      assert.equal(published.id, options.id); assert.equal(published.pid, process.pid)
      assert.equal(published.password, options.password)
      const nativeFetch = globalThis.fetch, nativeKill = process.kill
      const directory = ${JSON.stringify(directory)}
      const stateDir = path.join(os.tmpdir(), "opencode/personalize-startup-state")
      let alive = true, kills = 0, mode = "timeout"
      process.kill = (pid, signal) => {
        assert.equal(pid, process.pid, "test must never signal any external process")
        if (signal === 0) { if (!alive) throw new Error("gone"); return true }
        kills++; alive = false; return true
      }
      globalThis.fetch = async (url, options) => {
        assert.equal(new URL(url).hostname, "127.0.0.1")
        if (mode === "timeout") return new Promise((_, reject) => {
          if (options.signal.aborted) return reject(options.signal.reason)
          options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true })
        })
        return new Response(JSON.stringify({ pid: process.pid, version: "test" }),
          { status: mode === "ready" ? 200 : mode === "failed" ? 500 : 503 })
      }
      const keepAlive = setInterval(() => {}, 100)
      try {
        assert.equal(defaultEnsureTiming.promiseTimeout, 120000)
        for (const kind of ["promise", "effect"]) {
          alive = true; kills = 0; mode = "timeout"
          const info = { id: kind, pid: process.pid, url: "http://127.0.0.1:1", version: "test", password: "secret" }
          const finish = publishStartup(info)
          try {
            const probe = await probeResult(info, 10)
            assert.equal(probe.service.state, "waiting")
            assert.equal(probe.timedOut, false)
            assert.equal(decide(probe.service, { version: "new-version" })._tag, "wait")
            const file = path.join(directory, kind + ".json")
            fs.writeFileSync(file, JSON.stringify(info))
            const options = withEnsureTiming({ file, version: "test",
              command: [process.execPath, "-e", "process.exit(42)"] }, {
              requestTimeout: 10, pollInterval: 5, promiseTimeout: 180,
              spawnDelay: 1000, stopPollInterval: 1, stopPollAttempts: 2,
            })
            const ensure = () => kind === "promise" ? promiseClient.ensure(options) :
              Effect.runPromise(effectClient.ensure(options).pipe(Effect.provide(NodeServices.layer)))
            const begun = performance.now()
            await assert.rejects(ensure(), /Timed out waiting/)
            assert.equal(kills, 0, "starting owner must survive blocked health")
             const elapsed = performance.now() - begun
             assert.ok(elapsed < 1000, kind + ": local startup state must not extend ensure deadline (" + elapsed + "ms)")
            mode = "ready"
            assert.equal((await ensure()).url, info.url, "only real ready health may return an endpoint")
            mode = "failed"
            await assert.rejects(ensure(), /failed to start/)
            mode = "timeout"
            const marker = fs.readdirSync(stateDir).find(name => name.endsWith(".json"))
            fs.writeFileSync(path.join(stateDir, marker), JSON.stringify({
              protocol: 1, startedAt: Date.now() - startupGraceMs - 1,
            }))
            assert.equal(isStarting(info), false)
            assert.equal((await probeResult(info, 10)).timedOut, true)
            await assert.rejects(ensure())
            assert.equal(kills, 1, "expired startup must retain actual stock hang recovery")
          } finally { finish() }
        }
        alive = true
        const info = { id: "ready-then-hung", pid: process.pid, url: "http://127.0.0.1:1", version: "test", password: "secret" }
        const finish = publishStartup(info)
        finish()
        assert.equal((await probeResult(info, 10)).timedOut, true, "finished bootstrap cannot mask a ready-service hang")
      } finally {
        clearInterval(keepAlive)
        globalThis.fetch = nativeFetch; process.kill = nativeKill
      }
      console.log("Effect cancellation and both real client recovery loops passed")
    `)
    const launcher = path.join(directory, "build.mjs")
    writeFileSync(launcher, `
      import { build } from ${source(".personalize/build.mjs")}
      const result = await build({
        entrypoints: [${JSON.stringify(entry)}], target: "bun",
        define: { OPENCODE_VERSION: '"test"', OPENCODE_CHANNEL: '"local"' },
        write: false,
      }, { root: ${JSON.stringify(root)} })
      if (!result.success) throw new Error(result.logs.map(String).join("\\n"))
      await Bun.write(${JSON.stringify(path.join(directory, "bundle.mjs"))}, result.outputs[0])
      const child = Bun.spawnSync([process.execPath, ${JSON.stringify(path.join(directory, "bundle.mjs"))}],
        { stdout: "inherit", stderr: "inherit", timeout: 20000 })
      process.exit(child.exitCode)
    `)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/^(OPENCODE_|XDG_|OTEL_)/.test(key) && !/(TOKEN|SECRET|PASSWORD|API_KEY)/i.test(key)))
    Object.assign(env, {
      HOME: path.join(directory, "home"), USERPROFILE: path.join(directory, "home"),
      TMPDIR: path.join(directory, "tmp"), TMP: path.join(directory, "tmp"), TEMP: path.join(directory, "tmp"),
      XDG_STATE_HOME: path.join(directory, "state"), XDG_CONFIG_HOME: path.join(directory, "config"),
      XDG_DATA_HOME: path.join(directory, "data"), XDG_CACHE_HOME: path.join(directory, "cache"),
      OPENCODE_TEST_HOME: path.join(directory, "home"),
    })
    const result = spawnSync(process.env.BUN_EXECUTABLE ?? "bun", [launcher],
      { cwd: root, env, encoding: "utf8", timeout: 30_000 })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stdout + result.stderr)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test("database bootstrap stays serialized when contenders share state but have different TEMP directories", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "opencode-shared-boot-"))
  for (const part of ["home", "state", "data", "first-temp", "second-temp", "config", "cache"])
    mkdirSync(path.join(directory, part))
  try {
    const entry = path.join(directory, "database.ts")
    writeFileSync(entry, `
      import fs from "node:fs"
      import path from "node:path"
      import { Effect, Layer } from ${effect}
      import { Global } from ${source("packages/util/src/global.ts")}
      import { decorate } from ${source("packages/core/src/personalize/database.ts")}
      const directory = ${JSON.stringify(directory)}
      const role = process.argv[2]
      const witness = path.join(directory, "critical-section")
      const database = decorate({ layer: () => Layer.effectDiscard(Effect.acquireUseRelease(
        Effect.sync(() => {
          fs.writeFileSync(witness, role, { flag: "wx" })
          console.log("entered")
        }),
        () => Effect.sleep(role === "first" ? "800 millis" : "5 millis"),
        () => Effect.sync(() => fs.unlinkSync(witness)),
      )) })
      await Effect.runPromise(Effect.scoped(Layer.build(database.layer({ path: "fixture.db" })).pipe(
        Effect.provideService(Global.Service, {
          state: path.join(directory, "state"), data: path.join(directory, "data"),
        }),
      )))
    `)
    const launcher = path.join(directory, "build.mjs")
    writeFileSync(launcher, `
      import assert from "node:assert/strict"
      import { build } from ${source(".personalize/build.mjs")}
      const result = await build({ entrypoints: [${JSON.stringify(entry)}], target: "bun", write: false },
        { root: ${JSON.stringify(root)} })
      if (!result.success) throw new Error(result.logs.map(String).join("\\n"))
      const bundle = ${JSON.stringify(path.join(directory, "database.mjs"))}
      await Bun.write(bundle, result.outputs[0])
      function child(role, temporary) {
        return Bun.spawn([process.execPath, bundle, role], {
          env: { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
          stdout: "pipe", stderr: "pipe",
        })
      }
      const first = child("first", ${JSON.stringify(path.join(directory, "first-temp"))})
      let second
      try {
        const reader = first.stdout.getReader()
        const initial = await reader.read()
        assert.match(new TextDecoder().decode(initial.value), /entered/)
        reader.releaseLock()
        second = child("second", ${JSON.stringify(path.join(directory, "second-temp"))})
        const [firstCode, secondCode, firstError, secondError] = await Promise.all([
          first.exited, second.exited,
          new Response(first.stderr).text(), new Response(second.stderr).text(),
        ])
        assert.equal(firstCode, 0, firstError)
        assert.equal(secondCode, 0, "different TEMP directories must not split database ownership: " + secondError)
      } finally {
        if (first.exitCode === null) first.kill()
        if (second?.exitCode === null) second.kill()
        await Promise.all([first.exited, second?.exited])
      }
    `)
    const result = spawnSync(process.env.BUN_EXECUTABLE ?? "bun", [launcher], {
      cwd: root, encoding: "utf8", timeout: 20_000,
      env: { ...process.env, HOME: path.join(directory, "home"), USERPROFILE: path.join(directory, "home"),
        OPENCODE_TEST_HOME: path.join(directory, "home"), XDG_STATE_HOME: path.join(directory, "state"),
        XDG_DATA_HOME: path.join(directory, "data"), XDG_CONFIG_HOME: path.join(directory, "config"),
        XDG_CACHE_HOME: path.join(directory, "cache"), OPENCODE_CONFIG_CONTENT: "{}" },
    })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stdout + result.stderr)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
