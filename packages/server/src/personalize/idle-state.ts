import { Lifetime } from "@opencode/util/personalize-lifetime"
import { settings, sleeping, evictSelf } from "@opencode/util/personalize-lifetime-store"

export const lifetime = new Lifetime(settings())

// Exactly one deadline timer, rescheduled by actual client/job transitions.
// No heartbeat heuristics, watchdog polling, fibers, or spawned processes.
export function armIdleWatchdog(soft: () => void, hard = () => {
  try { process.kill(process.pid, "SIGKILL") } catch {}
  process.exit(137)
}) {
  let timer: ReturnType<typeof setTimeout> | undefined
  let disarmed = false
  function schedule() {
    if (timer) clearTimeout(timer)
    timer = undefined
    if (disarmed) return
    const next = lifetime.next()
    if (!next) return
    timer = setTimeout(() => {
      const due = lifetime.next()
      if (!due || due.after > 0) return schedule()
      // Write before disconnecting: existing windows must park, not respawn it.
      try { sleeping(due.kind) } catch (error) {
        console.error("[personalize] cannot record service sleep", error)
        if (due.kind === "soft") {
          // Avoid a soft-stop/auto-respawn loop. Hard control stays armed.
          lifetime.softBlocked = true
          return schedule()
        }
      }
      console.error(`[personalize] ${due.kind} lifetime deadline reached`)
      if (due.kind === "hard") {
        lifetime.stopped = true
        try { evictSelf() } catch {}
        hard()
      } else {
        lifetime.softStopping = true
        try { soft() } finally { schedule() }
      }
    }, next.after)
    timer.unref?.()
  }
  lifetime.changed = schedule
  schedule()
  return () => {
    disarmed = true
    if (timer) clearTimeout(timer)
    lifetime.changed = () => {}
  }
}
