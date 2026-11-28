import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// A one-shot startup allowance, NOT a health/ready result or a renewable lease.
// At expiry the unchanged client timeout/recovery rules resume.
export const startupGraceMs = 30_000
export type StartupIdentity = {
  id?: string
  pid: number
  url: string
  version?: string
  password?: string
}

function filename(info: StartupIdentity, directory: string) {
  if (!info.id || !info.password || !Number.isSafeInteger(info.pid) || info.pid <= 0) return
  const key = createHash("sha256").update(JSON.stringify([
    info.id, info.pid, info.url, info.version, info.password,
  ])).digest("hex")
  return path.join(directory, key + ".json")
}
const root = () => path.join(os.tmpdir(), "opencode", "personalize-startup-state")
// Bound the allowance by monotonic time after the first observation, even if
// the wall clock changes. Retain expired observations rather than re-arm them.
const observed = new Map<string, number>()

export function publishStartup(info: StartupIdentity, directory = root()) {
  const file = filename(info, directory)
  if (!file) return () => {}
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  // Instance ID is random and registered by the CLI. Exclusive create means a
  // second publish cannot renew an existing instance's allowance.
  writeFileSync(file, JSON.stringify({ protocol: 1, startedAt: Date.now() }), { flag: "wx", mode: 0o600 })
  let finished = false
  return () => {
    if (finished) return
    finished = true
    // Unique full-generation path: no successor's state can be removed here.
    try { unlinkSync(file) } catch {}
  }
}

export function isStarting(info: StartupIdentity, directory = root()): boolean {
  const file = filename(info, directory)
  if (!file) return false
  try {
    const state = JSON.parse(readFileSync(file, "utf8"))
    const age = Date.now() - state.startedAt
    if (state.protocol !== 1 || !Number.isSafeInteger(state.startedAt) || age < 0 || age >= startupGraceMs)
      return false
    let deadline = observed.get(file)
    if (deadline === undefined) {
      if (observed.size >= 256) observed.delete(observed.keys().next().value!)
      deadline = performance.now() + startupGraceMs - age
      observed.set(file, deadline)
    }
    if (performance.now() >= deadline) return false
    // ESRCH, permission errors and uncertain liveness all fail closed. This
    // check never grants lock ownership or deletes anything.
    process.kill(info.pid, 0)
    return true
  } catch {
    return false
  }
}
