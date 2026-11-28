import { Deferred, Effect, Semaphore } from "effect"
import { readFacts, withFacts, type Facts } from "@opencode/schema/personalize/permission-policy"
import type { Reply as PolicyReply, InvalidPolicyError } from "@opencode/schema/personalize/permission-contract"
import type { Permission as SchemaPermission } from "@opencode/schema/permission"
import type { SessionErrors } from "../session/error.js"
import type { Permission as CorePermission } from "../permission.js"
import type { Bus } from "../bus.js"
import type { SessionStore } from "../session/store.js"
import type { PluginHooks } from "../plugin/hooks.js"
import { PermissionPolicy } from "../permission/policy.js"
import { SessionGrant } from "../permission/session-grant.js"
import { makePermissionPolicy, type Pending } from "./permission-policy"
import { CurrentPermission } from "./permission-hook"
import { PermissionBinding } from "./permission-node.js"
export { permissionNode } from "./permission-node.js"
export { InvalidPolicyError } from "@opencode/schema/personalize/permission-contract"

type Input = CorePermission.AssertInput & Partial<Facts>
type Request = SchemaPermission.Request
type Reply = PolicyReply
type Declined = CorePermission.DeclinedError
type Corrected = CorePermission.CorrectedError
type PendingEntry = {
  readonly request: Request
  readonly agent?: Input["agent"]
  readonly deferred: Deferred.Deferred<void, Declined | Corrected>
}
export type PolicyError = CorePermission.NotFoundError | SessionErrors.NotFoundError | InvalidPolicyError

// Requests are protocol data, not shared authorization state. In-process event
// listeners and callers of get/list/forSession must not mutate a pending entry's
// resources, source or CRUD facts before a later policy recheck.
const snapshot = <T>(value: T): T => structuredClone(value)

export interface ConnectOptions {
  readonly pending: Map<Request["id"], PendingEntry>
  readonly configured: (sessionID: Request["sessionID"], agent?: Input["agent"]) =>
    Effect.Effect<PermissionPolicy.Policy, SessionErrors.NotFoundError>
  readonly savedPolicy: () => Effect.Effect<PermissionPolicy.Policy>
  readonly row: (source: Input["source"]) => Input["source"]
  readonly cleanMetadata: (metadata: NonNullable<Input["metadata"]>) => NonNullable<Input["metadata"]>
  readonly bus: Bus.Interface
  readonly sessions: SessionStore.Interface
  readonly hooks: PluginHooks.Interface
  readonly unattended: Effect.Effect<SchemaPermission.Ruleset | undefined>
  readonly events: typeof import("@opencode/schema/permission").Permission.Event
  readonly makeID: () => Request["id"]
  readonly missingSession: (id: Request["sessionID"]) => SessionErrors.NotFoundError
  readonly missingRequest: (id: Request["id"]) => CorePermission.NotFoundError
  readonly invalidPolicy: (message: string) => InvalidPolicyError
  readonly declined: () => Declined
  readonly isClosed: () => boolean
}

/** Fields must survive stock request() by travelling inside metadata. */
function encoded(input: Input): Input {
  const facts = readFacts(input)
  return facts ? withFacts(input, facts) : input
}

function decoded<T extends Input | Request>(input: T): T {
  const facts = readFacts(input)
  return facts ? { ...input, ...facts } : input
}

/**
 * The request lifecycle extension shares stock's pending map. Stock still owns
 * assertions, ordinary reply handling, close and nested source mappings.
 */
export const createPermissionRuntime = Effect.fn("Personalize.createPermissionRuntime")(function* (options: ConnectOptions) {
  const binding = yield* PermissionBinding
  if (!binding) return yield* Effect.die(new Error("Permission runtime requires its location-node factory"))
  const { db } = binding
  const lock = Semaphore.makeUnsafe(1)
  let owner: number | undefined
  const exclusive = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.withFiber((fiber) => owner === fiber.id ? effect : lock.withPermit(
      Effect.sync(() => { owner = fiber.id }).pipe(
        Effect.andThen(effect),
        Effect.ensuring(Effect.sync(() => { owner = undefined })),
      ),
    ))
  let closed = false
  const originalInputs = new Map<Request["id"], Input>()
  const lineage = new Map<Request["id"], Request["id"]>()
  const claiming = new Set<Request["id"]>()
  const cancelled = new Set<Request["id"]>()

  const policy = makePermissionPolicy({
    bus: options.bus,
    sessions: options.sessions,
    db,
    missingSession: options.missingSession,
    missingRequest: options.missingRequest,
    invalidPolicy: options.invalidPolicy,
    configured: (input) => options.configured(input.sessionID, input.agent),
    savedPolicy: options.savedPolicy,
    unattended: () => options.unattended,
    evaluateEvent: (input, effect, sourceIsRow) => Effect.gen(function* () {
      const event: PluginHooks.Domains["permission"]["evaluate"] = {
        sessionID: input.sessionID, agent: input.agent, action: input.action,
        resources: input.resources, metadata: input.metadata,
        source: sourceIsRow ? input.source : options.row(input.source),
        effect,
      }
      return yield* options.hooks.trigger("permission", "evaluate", event)
    }),
  })

  const evaluate = (input: Input) => exclusive(Effect.gen(function* () {
    if (closed) return { effect: "deny" as const, policy: PermissionPolicy.empty, message: "Permission service is closed" }
    const invocation = yield* CurrentPermission
    return yield* policy.evaluate(decoded(input), invocation?.consume ?? true, invocation === undefined)
  }))
  yield* Effect.addFinalizer(() => Effect.sync(() => {
    originalInputs.clear()
    lineage.clear()
    claiming.clear()
    cancelled.clear()
    policy.close()
  }))

  const identities = new WeakMap<Pending, PendingEntry>()
  const pendingValue = (entry: PendingEntry): Pending => {
    const result: Pending = {
      request: decoded(entry.request),
      agent: entry.agent ?? originalInputs.get(entry.request.id)?.agent,
    }
    identities.set(result, entry)
    return result
  }
  const reevaluate = (entry: Pending, consume: boolean, selected?: readonly SessionGrant.Grant[]) =>
    policy.evaluate({ ...entry.request, agent: entry.agent }, consume, true, selected)

  const settle = (item: Pending, effect: "allow" | "deny", _reply: Reply) =>
    Effect.gen(function* () {
      const entry = options.pending.get(item.request.id)
      if (!entry || entry !== identities.get(item)) return false
      // Claim before publishing; no other reply may settle this entry twice.
      options.pending.delete(item.request.id)
      originalInputs.delete(item.request.id)
      // Publish the actual settlement, not a policy that might only partially
      // apply. Stock reply("reject") would reject the entire message batch.
      yield* options.bus.publish(options.events.Replied, {
        sessionID: entry.request.sessionID, requestID: entry.request.id,
        reply: effect === "allow" ? "once" : "reject",
      }).pipe(
        Effect.onError(() => Deferred.fail(entry.deferred, options.declined())),
        Effect.andThen(effect === "allow"
          ? Deferred.succeed(entry.deferred, undefined)
          : Deferred.fail(entry.deferred, options.declined())),
      )
      return true
    })

  const callbacks = {
    get: (id: Request["id"]) => Effect.sync(() => {
      const entry = options.pending.get(id)
      return entry && pendingValue(entry)
    }),
    list: () => Effect.sync(() => [...options.pending.values()].map(pendingValue)),
    reevaluate,
    settle,
    batch: (
      items: readonly { pending: Pending; effect: SchemaPermission.Effect }[],
      commit: (guard: () => void) => Effect.Effect<void, SessionErrors.NotFoundError | InvalidPolicyError>,
    ) => Effect.gen(function* () {
      const claimed: { item: Pending; entry: PendingEntry; root: Request["id"]; input?: Input; effect: SchemaPermission.Effect }[] = []
      for (const item of items) {
        const entry = options.pending.get(item.pending.request.id)
        if (!entry || entry !== identities.get(item.pending))
          return yield* options.missingRequest(item.pending.request.id)
        claimed.push({ item: item.pending, entry, root: lineage.get(item.pending.request.id) ?? item.pending.request.id,
          input: originalInputs.get(item.pending.request.id), effect: item.effect })
      }
      for (const { item, root } of claimed) {
        claiming.add(root)
        options.pending.delete(item.request.id)
        originalInputs.delete(item.request.id)
      }
      yield* Effect.gen(function* () {
        // Replied is advisory: a subsequent CAS or recheck can still fail.
        // Never commit authorization if any of these publications fails.
        for (const { entry, effect } of claimed) {
          if (effect === "ask") continue
          yield* options.bus.publish(options.events.Replied, {
            sessionID: entry.request.sessionID, requestID: entry.request.id,
            reply: effect === "allow" ? "once" : "reject",
          })
        }
        if (claimed.some(({ root }) => cancelled.has(root)))
          return yield* Effect.die(new Error("Permission request was cancelled during publication"))
        // All fallible policy/hooks work must finish before durable authorization.
        // Commit is the last fallible operation; only in-memory waiter release follows.
        yield* commit(() => {
          if (closed || claimed.some(({ root }) => cancelled.has(root)))
            throw new Error("Permission request was cancelled before authorization")
        })
        for (let i = 0; i < claimed.length; i++) {
          if (claimed[i].effect === "ask") {
            const { item, entry, input } = claimed[i]
            options.pending.set(item.request.id, entry)
            if (input) originalInputs.set(item.request.id, input)
            continue
          }
          lineage.delete(claimed[i].item.request.id)
          yield* claimed[i].effect === "allow" ? Deferred.succeed(claimed[i].entry.deferred, undefined)
            : Deferred.fail(claimed[i].entry.deferred, options.declined())
        }
      }).pipe(Effect.onError(() => Effect.gen(function* () {
        if (closed) {
          for (const { entry } of claimed) yield* Deferred.fail(entry.deferred, options.declined())
          return
        }
        const renewed: PendingEntry[] = []
        for (const { item, entry, input, root } of claimed) {
          if (cancelled.has(root)) {
            yield* Deferred.fail(entry.deferred, options.declined())
            lineage.delete(item.request.id)
            continue
          }
          let id = options.makeID()
          while (options.pending.has(id) || originalInputs.has(id) || claimed.some(({ item }) => item.request.id === id))
            id = options.makeID()
          const next = { ...entry, request: { ...entry.request, id } }
          lineage.delete(item.request.id)
          lineage.set(id, root)
          options.pending.set(id, next)
          if (input) originalInputs.set(id, { ...input, id })
          renewed.push(next)
        }
        // Replied is advisory and may already have reached a UI. Reannounce the
        // original request; failure to notify does not remove its actionable entry.
        for (const entry of renewed)
          yield* options.bus.publish(options.events.Asked, snapshot(entry.request)).pipe(
            Effect.catchCause(() => Effect.void),
          )
      })), Effect.ensuring(Effect.sync(() => {
        for (const { root } of claimed) {
          claiming.delete(root)
          cancelled.delete(root)
        }
      })))
    }),
  }

  /** Call only after stock Asked publication succeeds, while retaining its entry. */
  const registered = (entry: PendingEntry) => exclusive(Effect.gen(function* () {
    if (closed || options.pending.get(entry.request.id) !== entry) return
    const item = pendingValue(entry)
    const result = yield* reevaluate(item, true)
    if (result.effect !== "ask")
      yield* settle(item, result.effect, result.effect === "allow" ? "once" : "reject")
  }).pipe(
    Effect.onError(() => Effect.gen(function* () {
      if (options.pending.get(entry.request.id) === entry) options.pending.delete(entry.request.id)
      originalInputs.delete(entry.request.id)
      yield* Deferred.fail(entry.deferred, options.declined())
    })),
    Effect.uninterruptible,
  ))

  // Registration and its post-publication race check form one lifecycle.
  // Preserve stock metadata filtering, deferred ownership and duplicate checks.
  const request = (input: Input, message?: string): Request => ({
    id: input.id ?? options.makeID(),
    sessionID: input.sessionID,
    action: input.action,
    resources: input.resources,
    save: input.save,
    metadata: input.metadata && options.cleanMetadata(input.metadata),
    source: options.row(input.source),
    message,
  })
  const create = (request: Request, agent?: Input["agent"]) => Effect.uninterruptible(
    Effect.gen(function* () {
      const deferred = yield* Deferred.make<void, Declined | Corrected>()
      const item = { request: snapshot(request), agent, deferred }
      if (options.isClosed()) {
        yield* Deferred.fail(deferred, options.declined())
        return item
      }
      if (options.pending.has(request.id))
        return yield* Effect.die(new Error(`Duplicate pending permission ID: ${request.id}`))
      options.pending.set(request.id, item)
      yield* options.bus.publish(options.events.Asked, snapshot(item.request)).pipe(
        Effect.onError(() => Effect.sync(() => options.pending.delete(request.id))),
      )
      yield* registered(item)
      return item
    }),
  )

  // Replied events release retained invocation context. Asked is deliberately
  // not settled here: a listener runs inside publication, not after it.
  const unsubscribe = yield* options.bus.listen((event) => {
    if (event.type === options.events.Replied.type) {
      const data = event.data as { requestID: Request["id"] }
      return Effect.sync(() => { originalInputs.delete(data.requestID) })
    }
    return Effect.void
  })
  yield* Effect.addFinalizer(() => unsubscribe)

  const connect = (original: CorePermission.Interface) => Effect.gen(function* () {
  const invoke = <A, E, R>(effect: Effect.Effect<A, E, R>, input: Input, consume: boolean) =>
    effect.pipe(Effect.provideService(CurrentPermission, { input: decoded(input), consume }))

  const ask: typeof original.ask = (input) => Effect.suspend(() => {
    const value = encoded({ ...input, id: input.id ?? options.makeID() })
    if (originalInputs.has(value.id!) || options.pending.has(value.id!))
      return Effect.die(new Error(`Duplicate pending permission ID: ${value.id}`))
    originalInputs.set(value.id!, value)
    return invoke(original.ask(value), value, true).pipe(
      Effect.tap((result) => Effect.sync(() => {
        if (result.effect !== "ask") originalInputs.delete(value.id!)
      })),
      Effect.onError(() => Effect.sync(() => { originalInputs.delete(value.id!) })),
    )
  })
  const assert: typeof original.assert = (input) => Effect.suspend(() => {
    const value = encoded({ ...input, id: input.id ?? options.makeID() })
    if (originalInputs.has(value.id!) || options.pending.has(value.id!))
      return Effect.die(new Error(`Duplicate pending permission ID: ${value.id}`))
    originalInputs.set(value.id!, value)
    return invoke(original.assert(value), value, true).pipe(
      Effect.ensuring(Effect.sync(() => {
        if (claiming.has(value.id!)) cancelled.add(value.id!)
        originalInputs.delete(value.id!)
        for (const [id, root] of lineage) {
          if (root !== value.id) continue
          options.pending.delete(id)
          originalInputs.delete(id)
          lineage.delete(id)
        }
      })),
    )
  })
  const assertNotDenied: typeof original.assertNotDenied = (input) =>
    invoke(original.assertNotDenied(encoded(input)), input, false)
  const allows: typeof original.allows = (input) =>
    invoke(original.allows(encoded(input)), input, false)
  const get: typeof original.get = (id) => original.get(id).pipe(Effect.map(snapshot))
  const list: typeof original.list = () => original.list().pipe(Effect.map(snapshot))
  const forSession: typeof original.forSession = (id) => original.forSession(id).pipe(Effect.map(snapshot))

  const reply = (input: Omit<CorePermission.ReplyInput, "reply"> & { readonly reply: Reply }) => exclusive(
    Effect.suspend(() => {
      if (closed) return Effect.fail(options.missingRequest(input.requestID))
      return policy.reply(input.requestID, input.reply, callbacks).pipe(
        Effect.flatMap((plan) => {
          if (plan.type !== "delegate") return Effect.void
          if (input.reply !== "once") return original.reply(input).pipe(Effect.provideService(CurrentPermission, undefined))
          return Effect.gen(function* () {
            const item = yield* callbacks.get(input.requestID)
            if (!item) return yield* options.missingRequest(input.requestID)
            const current = yield* reevaluate(item, false)
            const effect = current.effect === "deny" ? "deny" as const : "allow" as const
            yield* callbacks.batch([{ pending: item, effect }], (guard) => Effect.gen(function* () {
              const result = yield* reevaluate(item, false)
              if (effect === "allow" && result.effect === "deny")
                return yield* options.invalidPolicy("Permission was denied while approving; review the renewed request.")
              guard()
            }))
          })
        }),
      )
    }),
  )
  const close = exclusive(Effect.gen(function* () {
    if (closed) return
    closed = true
    yield* original.close.pipe(Effect.ensuring(Effect.gen(function* () {
      // A publication failure can stop stock close before it reaches later
      // entries. No waiter may survive shutdown, even when notification fails.
      for (const entry of options.pending.values())
        yield* Deferred.fail(entry.deferred, options.declined())
      options.pending.clear()
      originalInputs.clear()
      lineage.clear()
      claiming.clear()
      cancelled.clear()
      policy.close()
    })))
  }))
  yield* Effect.addFinalizer(() => close)
  return {
    ...original, ask, assert, assertNotDenied, allows, reply, close, get, list, forSession,
  }
  })
  if (binding.connect) return yield* Effect.die(new Error("Duplicate permission runtime binding"))
  binding.connect = connect
  return { evaluate, request, create }
})
