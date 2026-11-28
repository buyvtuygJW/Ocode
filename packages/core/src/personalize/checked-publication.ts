import { Deferred, Effect, PubSub } from "effect"
import type { Event } from "@opencode/schema/event"
import type { PublishOptions, Subscriber } from "../bus.js"
import type { KeyedMutex } from "../effect/keyed-mutex.js"

/** Listeners see an advisory, non-durable proposal; streams see committed events. */
export interface CheckedPublishOptions<E, C = never> extends PublishOptions<C> {
  readonly check: Effect.Effect<void, E>
}

export interface CheckedBus {
  readonly publishChecked: <D extends Event.DurableDefinition, E, C = never>(
    definition: D, data: Event.Data<D>, options: CheckedPublishOptions<E, C>,
  ) => Effect.Effect<Event.Payload<D>, E | C>
}

// Exact proposal identity, not an event ID or a global "publication mode".
// Entries exist only for the supervised worker's lifetime.
const receipts = new WeakMap<Event.Payload, (committed: Event.Payload) => Effect.Effect<void>>()

/** The explicit Bus seam calls this AFTER SQLite commits and BEFORE delivery. */
export const acknowledgeCommit = (proposal: Event.Payload, committed: Event.Payload) => Effect.suspend(() => {
  const receipt = receipts.get(proposal)
  return receipt ? receipt(committed) : Effect.void
})

export const makeCheckedPublisher = Effect.fn("Bus.makeCheckedPublisher")(function* (deps: {
  listeners: readonly Subscriber[]
  locks: KeyedMutex.KeyedMutex<string>
  makePayload: (definition: Event.Definition, data: unknown, options?: PublishOptions<unknown>) => Effect.Effect<Event.Payload>
  aggregateID: (type: string, aggregate: string, data: unknown) => Effect.Effect<string>
  commit: <C = never>(definition: Event.Definition, event: Event.Payload, input: undefined, commit?: PublishOptions<C>["commit"]) =>
    Effect.Effect<{ event: Event.Payload } | void, C>
  live: PubSub.PubSub<Event.Payload>
  typed: ReadonlyMap<string, ReadonlySet<PubSub.PubSub<Event.Payload>>>
}) {
  const scope = yield* Effect.scope
  function publishChecked<D extends Event.DurableDefinition, E, C = never>(
    definition: D, data: Event.Data<D>, options: CheckedPublishOptions<E, C>,
  ): Effect.Effect<Event.Payload<D>, E | C> {
    return Effect.uninterruptible(Effect.gen(function* () {
      const proposal = yield* deps.makePayload(definition, data, options)
      const aggregateID = yield* deps.aggregateID(definition.type, definition.durable.aggregate, data)
      // Fallible authorization work runs before the write and outside both
      // locks. Listeners may publish other events without deadlocking.
      for (const listener of [...deps.listeners])
        yield* Effect.suspend(() => listener(proposal))
      yield* options.check
      const receipt = yield* Deferred.make<Event.Payload, E | C>()
      receipts.set(proposal, (committed) => Deferred.succeed(receipt, committed).pipe(Effect.asVoid))
      // Retain the aggregate lock through observation, but release the caller
      // at the transaction receipt. Delivery cannot reverse a successful grant.
      yield* deps.locks.withLock(aggregateID)(Effect.gen(function* () {
        const committed = yield* deps.commit(definition, proposal, undefined, options.commit)
        if (!committed) return yield* Effect.die(new Error("Checked publication did not commit"))
        // The stock commit already routed the event and woke durable readers.
        // Live precedes typed delivery, whose subscribers may publish followups.
        yield* PubSub.publish(deps.live, committed.event)
        const typed = deps.typed.get(committed.event.type)
        if (typed) yield* Effect.forEach(typed, (subscriber) => PubSub.publish(subscriber, committed.event), { discard: true })
      })).pipe(
        Effect.catchCause((cause) => Deferred.failCause(receipt, cause).pipe(
          Effect.flatMap((failed) => failed ? Effect.void : Effect.logError("Committed event delivery failed", {
            eventID: proposal.id, eventType: proposal.type, cause,
          })),
        )),
        Effect.ensuring(Effect.sync(() => { receipts.delete(proposal) })),
        Effect.uninterruptible,
        Effect.forkIn(scope),
      )
      return (yield* Deferred.await(receipt)) as Event.Payload<D>
    }))
  }
  return { publishChecked } satisfies CheckedBus
})
