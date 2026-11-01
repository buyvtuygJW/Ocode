import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { Flock } from "@opencode/util/flock"
import { PersonalizeBoot } from "@opencode/util/personalize-boot"

export function decorate(stock: typeof import("../process")) {
  // Forward every argument. Upstream's `start(options, lifecycle?, transform?,
  // remoteURLs?)` registers the service through `lifecycle.onListen`; binding
  // only `options` here dropped the registration callback, so spawned service
  // contenders bound the port but never registered — their CLIs timed out and
  // left detached port-squatting zombies behind ("Managed service port ...
  // already in use", no instance ever becoming the host).
  const start: typeof stock.start = (options, ...rest) => Effect.acquireUseRelease(
    Effect.promise((signal) =>
      Flock.acquire("service-bootstrap", {
        dir: path.join(os.tmpdir(), "opencode", "personalize-boot-locks"), signal,
      }).then((lease) => {
        // Flock refuses a second release (metadata is deleted on the first);
        // the boot-service release and the finalizer share one guarded
        // release so whichever fires first wins and the other no-ops.
        let done = false
        const release = () => {
          if (done) return Promise.resolve()
          done = true
          return lease.release()
        }
        return { release }
      })
    ),
    (boot) => stock.start(options, ...rest).pipe(Effect.provideService(PersonalizeBoot, {
      retry: Effect.void, release: Effect.promise(() => boot.release()),
    })),
    (boot) => Effect.promise(() => boot.release()),
  )
  return { start }
}
