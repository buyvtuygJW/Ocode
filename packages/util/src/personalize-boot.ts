import { Context, Effect, Option } from "effect"
import { acquireBootLock, type BootLease } from "./personalize-boot-lock.js"
import type { StartupIdentity } from "./personalize-startup-state.js"

export interface BootState {
  retry: Effect.Effect<void>
  release: Effect.Effect<void>
  register?: (info: StartupIdentity) => void
}
export class PersonalizeBoot extends Context.Service<PersonalizeBoot, BootState>()("@personalize/Boot") {}

export const updateBoot = (kind: "retry" | "release") => Effect.serviceOption(PersonalizeBoot).pipe(
  Effect.flatMap((state) => Option.isSome(state) ? state.value[kind] : Effect.void),
)

export function withBootLock<A, E, R>(
  key: string,
  use: (lease: BootLease) => Effect.Effect<A, E, R>,
  options: { directory?: string } = {},
) {
  // acquireUseRelease normally masks interruption during acquisition. Install
  // a holder's finalizer FIRST, then wait interruptibly in its use phase. Store
  // the connection before resolving the promise so an interrupt at the handoff
  // cannot lose the lease.
  return Effect.acquireUseRelease(
    Effect.sync(() => ({ lease: undefined as BootLease | undefined, closed: false })),
    (holder) => Effect.promise((signal) => acquireBootLock(key, { ...options, signal }).then((lease) => {
      holder.lease = lease
      // Effect can finish interrupting before this promise's microtask runs.
      // A late acquisition must close itself, not resurrect a finalized scope.
      if (holder.closed || signal.aborted) {
        lease.release()
        signal.throwIfAborted()
        throw new Error("Bootstrap acquisition scope closed")
      }
      return lease
    })).pipe(Effect.flatMap(use)),
    (holder) => Effect.sync(() => {
      holder.closed = true
      holder.lease?.release()
    }),
  )
}

export function sqliteBusy(input: unknown): boolean {
  const seen = new Set<unknown>()
  const visit = (value: unknown): boolean => {
    if (value === null || value === undefined || seen.has(value)) return false
    seen.add(value)
    if (typeof value === "string") return /SQLITE_(?:BUSY|LOCKED)|database (?:is )?(?:locked|busy)/i.test(value)
    if (typeof value !== "object") return false
    const record = value as Record<string, unknown>
    if ([record.message, record.code, record.errno].some((part) => typeof part === "string" && visit(part))) return true
    return [record.cause, record.error, record.reason, record.reasons, record.left, record.right]
      .some((part) => Array.isArray(part) ? part.some(visit) : visit(part))
  }
  return visit(input)
}
