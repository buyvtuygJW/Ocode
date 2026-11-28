import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

const root = process.env.PERSONALIZE_SOURCE ?? fileURLToPath(new URL("../", import.meta.url))
const moduleURL = (name) => JSON.stringify(path.join(root, "packages/util/src", name).replaceAll("\\", "/"))

test("native bootstrap ownership: death, cancellation, contention, stale release and bounded hangs", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "opencode-boot-ownership-"))
  try {
    const script = path.join(directory, "check.mjs")
    writeFileSync(script, `
      import assert from "node:assert/strict"
      import { once } from "node:events"
      import { spawn } from "node:child_process"
      import { readdirSync, readFileSync, writeFileSync } from "node:fs"
      import { setTimeout as sleep } from "node:timers/promises"
      import { acquireBootLock } from ${moduleURL("personalize-boot-lock.ts")}
      import { publishStartup, isStarting, startupGraceMs } from ${moduleURL("personalize-startup-state.ts")}
      const directory = ${JSON.stringify(directory)}
      const options = { directory, timeoutMs: 2000 }
      const first = await acquireBootLock("same", options)
      let pulse = false
      setTimeout(() => { pulse = true }, 10)
      const begun = performance.now()
      await assert.rejects(acquireBootLock("same", { ...options, timeoutMs: 150 }), /Timed out/)
      assert.ok(pulse, "contention must yield to the event loop")
      assert.ok(performance.now() - begun < 1000, "live-owner wait must be bounded")
      const abort = new AbortController()
      const pending = acquireBootLock("same", { ...options, signal: abort.signal })
      abort.abort()
      await assert.rejects(pending)
      await assert.rejects(acquireBootLock("aborted", { ...options, signal: abort.signal }))
      first.release()
      const second = await acquireBootLock("same", options)
      first.release() // must not release the successor, including same PID
      await assert.rejects(acquireBootLock("same", { ...options, timeoutMs: 50 }), /Timed out/)
      second.release()
      const childFile = directory + "/owner.mjs"
      writeFileSync(childFile, \`
        import { acquireBootLock } from ${moduleURL("personalize-boot-lock.ts")}
        const lease = await acquireBootLock("crash", { directory: \${JSON.stringify(directory)} })
        console.log("owned")
        // An event-loop hang cannot defeat kernel-held ownership.
        for (;;) {}
      \`)
      const child = spawn(process.execPath, [childFile], { stdio: ["ignore", "pipe", "pipe"] })
      const exited = once(child, "exit")
      try {
        const [out] = await once(child.stdout, "data")
        assert.match(out.toString(), /owned/)
        await assert.rejects(acquireBootLock("crash", { ...options, timeoutMs: 100 }), /Timed out/)
        child.kill("SIGKILL")
        await exited
        const at = performance.now()
        const recovered = await acquireBootLock("crash", options)
        assert.ok(performance.now() - at < 1000, "dead owner must not leave a 60s lease")
        recovered.release()
      } finally {
        if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await exited }
      }
      // Three independent processes repeatedly enter the same critical section.
      // The exclusive witness file detects overlap instead of inferring it
      // from timestamps; it is not used as the ownership mechanism.
      const contenderFile = directory + "/contender.mjs"
      writeFileSync(contenderFile, \`
        import { acquireBootLock } from ${moduleURL("personalize-boot-lock.ts")}
        import { writeFileSync, unlinkSync } from "node:fs"
        import { setTimeout as sleep } from "node:timers/promises"
        for (let i = 0; i < 8; i++) {
          const lease = await acquireBootLock("race", { directory: \${JSON.stringify(directory)}, timeoutMs: 5000 })
          try {
            writeFileSync(\${JSON.stringify(directory + "/witness")}, "", { flag: "wx" })
            await sleep(5)
            unlinkSync(\${JSON.stringify(directory + "/witness")})
          } finally { lease.release() }
        }
      \`)
      const children = Array.from({ length: 3 }, () => spawn(process.execPath, [contenderFile],
        { stdio: ["ignore", "ignore", "pipe"] }))
      try {
        const results = await Promise.all(children.map(async c => {
          let errors = ""; c.stderr.on("data", x => { errors += x })
          const [code, signal] = await once(c, "exit")
          return { code, signal, errors }
        }))
        for (const r of results) assert.equal(r.code, 0, JSON.stringify(r))
      } finally {
        for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGKILL")
      }
      const info = { id: "generation-a", pid: process.pid, url: "http://127.0.0.1:1", version: "test", password: "private" }
      const done = publishStartup(info, directory)
      assert.equal(isStarting(info, directory), true)
      for (const change of [{ id: "generation-b" }, { pid: 2147483647 }, { password: "wrong" },
        { url: "http://127.0.0.1:2" }, { version: "other" }])
        assert.equal(isStarting({ ...info, ...change }, directory), false)
      assert.throws(() => publishStartup(info, directory), /EEXIST/)
      const stateFile = readdirSync(directory).find(x => x.endsWith(".json"))
      assert.ok(!readFileSync(directory + "/" + stateFile, "utf8").includes("private"))
      writeFileSync(directory + "/" + stateFile, JSON.stringify({ protocol: 1, startedAt: Date.now() - startupGraceMs - 1 }))
      assert.equal(isStarting(info, directory), false, "startup hang must resume stock recovery")
      done(); done()
      assert.equal(isStarting(info, directory), false)
      const newer = { ...info, id: "generation-b" }
      const finishNewer = publishStartup(newer, directory)
      done()
      assert.equal(isStarting(newer, directory), true, "old cleanup must not remove new generation")
      finishNewer()
      assert.equal(isStarting(newer, directory), false, "ready/failed states must stop startup protection")
      console.log("ownership and startup state passed", process.platform)
    `)
    const result = spawnSync(process.env.BUN_EXECUTABLE ?? "bun", [script], { encoding: "utf8", timeout: 20_000 })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stdout + result.stderr)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
