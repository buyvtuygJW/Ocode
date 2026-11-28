import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

export interface BootLease {
  release(): void
}

// These are empty *control* files, never the application database. SQLite's
// native file locks belong to the open connection and are released by the OS
// even on SIGKILL/TerminateProcess. Do not unlink them: replacing the inode
// would let two processes lock different files under the same name.
export async function acquireBootLock(key: string, options: {
  directory?: string
  signal?: AbortSignal
  timeoutMs?: number
} = {}): Promise<BootLease> {
  const timeout = options.timeoutMs ?? 90_000
  if (!Number.isFinite(timeout) || timeout < 0) throw new Error("Invalid boot-lock timeout")
  const deadline = performance.now() + timeout
  const directory = options.directory ?? path.join(os.tmpdir(), "opencode", "personalize-boot-locks-v2")
  const file = path.join(directory, createHash("sha256").update(key).digest("hex") + ".sqlite")
  options.signal?.throwIfAborted()
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  let firstAttempt = true
  for (;;) {
    options.signal?.throwIfAborted()
    if (!firstAttempt && performance.now() >= deadline) throw new Error("Timed out waiting for bootstrap ownership")
    firstAttempt = false
    let db: Database | undefined
    try {
      db = new Database(file, { create: true })
      // No native busy wait: yield to JS between attempts so cancellation and
      // health remain responsive. Never steal a live owner's lock by age/PID.
      db.run("PRAGMA busy_timeout=0")
      db.run("BEGIN EXCLUSIVE")
      options.signal?.throwIfAborted()
      const owned = db
      let released = false
      return { release() {
        if (released) return
        // This connection is the ownership capability. Closing an old lease
        // cannot close a successor's connection, even after PID reuse.
        owned.close()
        released = true
      } }
    } catch (error) {
      db?.close()
      if (!(error instanceof Error) || !("code" in error) ||
          (error.code !== "SQLITE_BUSY" && error.code !== "SQLITE_LOCKED")) throw error
    }
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new Error("Timed out waiting for bootstrap ownership")
    await sleep(Math.min(100, remaining), undefined, { signal: options.signal })
  }
}
