// Shared command syntax and pure lifetime policy. No processes, I/O, or timers.
export const defaults = { hardMs: 20_000, softMs: 10_000 }
export type Settings = typeof defaults
export type Stop = "hard" | "soft"

export function duration(input: string, fallback: number): number {
  if (input.trim() === "default") return fallback
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m)$/i.exec(input.trim())
  const ms = match ? Number(match[1]) * ({ ms: 1, s: 1000, m: 60_000 }[match[2].toLowerCase()] ?? 0) : NaN
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > 2_147_483_647)
    throw new Error("Use a positive duration such as 1s, 500ms, 1m, or default. Zero does not disable shutdown.")
  return ms
}

export class Lifetime {
  clients = 0
  jobs = 0
  requests = 0
  ready = false
  stopped = false
  softStopping = false
  softBlocked = false
  externalBusy = () => false
  private disconnected = 0
  private quiet = 0
  changed = () => {}
  settings: Settings
  private now: () => number

  constructor(settings: Settings = { ...defaults }, now = () => performance.now()) {
    this.settings = settings
    this.now = now
  }

  start() {
    this.ready = true
    this.disconnected = this.quiet = this.now()
    this.changed()
  }

  configure(settings: Settings) {
    this.settings = settings
    this.softBlocked = false
    // A custom value gets a full fresh countdown, not an already-expired one.
    this.disconnected = this.quiet = this.now()
    this.changed()
  }

  connect() {
    this.clients++
    this.changed()
    return this.once(() => {
      this.clients--
      if (this.clients === 0) this.disconnected = this.now()
      this.changed()
    })
  }

  work(kind: "jobs" | "requests" = "jobs") {
    this[kind]++
    this.changed()
    return this.once(() => {
      this[kind]--
      if (this.jobs === 0 && this.requests === 0) this.quiet = this.now()
      this.changed()
    })
  }

  next(): { kind: Stop; after: number } | undefined {
    if (!this.ready || this.stopped) return
    const hard = this.clients === 0 ? this.disconnected + this.settings.hardMs : Infinity
    let busy = true
    // A broken soft-state probe must never break or delay the hard timer.
    try { busy = this.externalBusy() } catch {}
    const soft = !this.softStopping && !this.softBlocked && this.jobs === 0 && this.requests === 0 && !busy
      ? this.quiet + this.settings.softMs : Infinity
    if (!Number.isFinite(Math.min(hard, soft))) return
    // Hard wins equal deadlines, and never waits for jobs or the soft timer.
    return hard <= soft
      ? { kind: "hard", after: Math.max(0, hard - this.now()) }
      : { kind: "soft", after: Math.max(0, soft - this.now()) }
  }

  private once(fn: () => void) {
    let done = false
    return () => {
      if (done) return
      done = true
      fn()
    }
  }
}

// Reconnect may wait here after an intentional sleep. Only user input wakes
// it; SSE retries do not authorize spawning a replacement server.
export class WakeGate {
  private allowed: number
  private pending = new Set<() => void>()
  private sleptAfter: (time: number) => boolean
  private now: () => number
  constructor(sleptAfter: (time: number) => boolean, now = () => Date.now()) {
    this.sleptAfter = sleptAfter
    this.now = now
    this.allowed = now()
  }
  wake() {
    this.allowed = this.now()
    for (const resolve of [...this.pending]) resolve()
  }
  wait(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(signal.reason)
    if (!this.sleptAfter(this.allowed)) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const done = () => { cleanup(); resolve() }
      const abort = () => { cleanup(); reject(signal.reason) }
      const cleanup = () => {
        this.pending.delete(done)
        signal.removeEventListener("abort", abort)
      }
      this.pending.add(done)
      signal.addEventListener("abort", abort, { once: true })
    })
  }
}
