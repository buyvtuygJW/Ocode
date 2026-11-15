export * as Permission from "./permission.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Deferred, Effect, Layer, Schema } from "effect"
import { Permission } from "@opencode/schema/permission"
import type { Tool } from "@opencode/schema/tool"
import { Bus } from "./bus.js"
import { Location } from "./location.js"
import { Agent } from "./agent.js"
import { SessionErrors } from "./session/error.js"
import { SessionSchema } from "./session/schema.js"
import { SessionStore } from "./session/store.js"
import { SessionProjector } from "./session/projector.js"
import { Wildcard } from "./util/wildcard.js"
import { PermissionSaved } from "./permission/saved.js"
import { PluginHooks } from "./plugin/hooks.js"
import { SessionGrant } from "./permission/session-grant.js"
import { eq } from "drizzle-orm"
import { Database } from "./database/database.js"
import { EventSequenceTable } from "./event/sql.js"
import { SessionEvent } from "@opencode/schema/session-event"

class PermissionSnapshotChanged extends Error {}

const PermissionEffect = Permission.Effect
export { PermissionEffect as Effect }
export { Rule, Ruleset, Operation, SessionPolicy, CompactPolicy } from "@opencode/schema/permission"
export { InvalidPolicyError } from "@opencode/schema/permission"
const missingAgentPermissions: Permission.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]

export const ID = Permission.ID
export type ID = typeof ID.Type

export const Source = Permission.Source
export type Source = typeof Source.Type

export const Request = Permission.Request
export type Request = typeof Request.Type

export const Reply = Permission.Reply
export type Reply = typeof Reply.Type

export interface AssertInput extends Omit<Request, "id" | "message"> {
  readonly id?: ID
  readonly agent?: Agent.ID
}

/** The requester fields of a permission request made by a tool call. */
export const invocation = (context: Pick<Tool.Context, "sessionID" | "agent" | "messageID" | "id">) => ({
  sessionID: context.sessionID,
  agent: context.agent,
  source: { type: "tool" as const, messageID: context.messageID, id: context.id },
})

export interface ReplyInput {
  readonly requestID: ID
  readonly reply: Reply
  readonly message?: string
}

export interface AskResult {
  readonly id: ID
  readonly effect: Permission.Effect
}

export { Event } from "@opencode/schema/permission"

/**
 * Rules that settle a request which would otherwise ask, for work nobody is present to answer, such as a schedule's
 * check. A request they do not allow is denied. Configured denies still win, as they are evaluated first.
 */
export const Unattended = Context.Reference<Permission.Ruleset | undefined>("@opencode/Permission/Unattended", {
  defaultValue: () => undefined,
})

export class DeclinedError extends Schema.TaggedError<DeclinedError>()("Permission.DeclinedError", {}) {}

export class CorrectedError extends Schema.TaggedError<CorrectedError>()("Permission.CorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return this.feedback
  }
}

export class BlockedError extends Schema.TaggedError<BlockedError>()("Permission.BlockedError", {
  rules: Permission.Ruleset,
  permission: Schema.String,
  resources: Schema.Array(Schema.String),
  reason: Schema.String.pipe(Schema.optional),
}) {
  override get message() {
    return this.reason ?? `Permission denied: ${this.permission}`
  }
}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("Permission.NotFoundError", {
  requestID: ID,
}) {}

export type Error = BlockedError | CorrectedError

export function evaluate(action: string, resource: string, ...rulesets: Permission.Ruleset[]): Permission.Rule {
  return (
    rulesets
      .flat()
      .findLast((rule) => Wildcard.match(action, rule.action) && Wildcard.match(resource, rule.resource)) ?? {
      action,
      resource: "*",
      effect: "ask",
    }
  )
}

export function merge(...rulesets: Permission.Ruleset[]): Permission.Ruleset {
  return rulesets.flat()
}

export interface Interface {
  readonly close: Effect.Effect<void>
  readonly ask: (input: AssertInput) => Effect.Effect<AskResult, SessionErrors.NotFoundError>
  readonly assert: (input: AssertInput) => Effect.Effect<void, Error | SessionErrors.NotFoundError>
  /** Fails only when the rules deny the request; never asks the user. */
  readonly assertNotDenied: (input: AssertInput) => Effect.Effect<void, BlockedError | SessionErrors.NotFoundError>
  /** True only when the rules already allow the request; never asks the user. */
  readonly allows: (input: AssertInput) => Effect.Effect<boolean, SessionErrors.NotFoundError>
  readonly reply: (input: ReplyInput) => Effect.Effect<void, NotFoundError | SessionErrors.NotFoundError | Permission.InvalidPolicyError>
  readonly get: (id: ID) => Effect.Effect<Request | undefined>
  readonly forSession: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Request>>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

interface Pending {
  readonly request: Request
  readonly agent?: Agent.ID
  readonly deferred: Deferred.Deferred<void, DeclinedError | CorrectedError>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const location = yield* Location.Service
    const agents = yield* Agent.Service
    const sessions = yield* SessionStore.Service
    const { db } = yield* Database.Service
    const saved = yield* PermissionSaved.Service
    const hooks = yield* PluginHooks.Service
    const pending = new Map<ID, Pending>()
    const onceListings: { sessionID: SessionSchema.ID; grant: SessionGrant.Grant }[] = []
    let closed = false

    const close = Effect.gen(function* () {
      closed = true
      yield* Effect.forEach(Array.from(pending.values()), (item) =>
        bus
          .publish(Permission.Event.Replied, {
            sessionID: item.request.sessionID,
            requestID: item.request.id,
            reply: "reject",
          })
          .pipe(Effect.ensuring(Deferred.fail(item.deferred, new DeclinedError()))),
      )
      pending.clear()
      onceListings.length = 0
    }).pipe(Effect.uninterruptible)
    yield* Effect.addFinalizer(() => close)

    const savedRules = Effect.fnUntraced(function* () {
      return (yield* saved.list({ projectID: location.project.id })).map(
        (item): Permission.Rule => ({
          action: item.action,
          resource: item.resource,
          effect: "allow",
        }),
      )
    })

    const configured = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, agentID?: Agent.ID) {
      const session = yield* sessions.get(sessionID)
      if (!session) return yield* new SessionErrors.NotFoundError({ sessionID })
      const agent = yield* agents.resolve(agentID ?? session.agent)
      return merge(agent?.permissions ?? missingAgentPermissions,
        (session.permissions ?? []).filter((rule) => rule.action !== SessionGrant.action))
    })

    const family = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      let id = sessionID
      const seen = new Set<SessionSchema.ID>()
      while (!seen.has(id)) {
        seen.add(id)
        const session = yield* sessions.get(id)
        if (!session) return yield* new SessionErrors.NotFoundError({ sessionID: id })
        if (!session.parentID) return id
        id = session.parentID
      }
      return yield* new SessionErrors.NotFoundError({ sessionID })
    })

    const sessionGrants = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const root = yield* family(sessionID)
      const session = yield* sessions.get(root)
      return yield* Effect.sync(() => {
        try { return SessionGrant.decode(session?.permissions ?? []) }
        catch { return undefined }
      })
    })

    const persist = Effect.fnUntraced(function* (root: SessionSchema.ID, additions: readonly SessionGrant.Grant[]) {
      if (!additions.length) return
      while (true) {
        // Read the projection and its aggregate sequence in the same database snapshot.
        // Release that transaction before publishing: Bus takes its aggregate lock before
        // its own immediate transaction, so publishing inside this transaction could deadlock.
        const snapshot = yield* db.transaction(
          (tx) => Effect.gen(function* () {
            const session = yield* sessions.get(root)
            const sequence = yield* tx.select({ seq: EventSequenceTable.seq })
              .from(EventSequenceTable)
              .where(eq(EventSequenceTable.aggregate_id, root))
              .get()
            return { session, seq: sequence?.seq ?? -1 }
          }),
          { behavior: "immediate" },
        ).pipe(Effect.orDie)
        const session = snapshot.session
        if (!session) return yield* new SessionErrors.NotFoundError({ sessionID: root })
        const previous = session.permissions
        const permissions = [...(previous ?? []).filter((rule) => {
          if (rule.action !== SessionGrant.action) return true
          const old = SessionGrant.decode([rule])[0]
          if (!old) return true
          return !additions.some((grant) => SessionGrant.contains(grant.directory, old.directory) &&
            SessionGrant.contains(old.directory, grant.directory) &&
            grant.operation === old.operation && grant.scope === old.scope)
        }), ...additions.map(SessionGrant.encode)]
        // The same durable event as Session.setPermissions. Bus runs commit after the
        // projector and before recording/dispatching the event, all in one transaction.
        // A concurrent event invalidates this snapshot; throwing rolls the projector
        // back too, then retries the merge without overwriting any intervening fields.
        const committed = yield* bus.publish(SessionEvent.Permissions, { sessionID: root, permissions }, {
          commit: (seq) => seq === snapshot.seq + 1 ? Effect.void : Effect.die(new PermissionSnapshotChanged()),
        }).pipe(
          Effect.as(true),
          Effect.catchDefect((defect) => defect instanceof PermissionSnapshotChanged
            ? Effect.succeed(false)
            : Effect.die(defect)),
        )
        if (committed) return
      }
    })

    function denied(input: Pick<Request, "action" | "resources">, rules: Permission.Ruleset) {
      return input.resources.some((resource) => evaluate(input.action, resource, rules).effect === "deny")
    }

    function relevant(input: AssertInput, rules: Permission.Ruleset) {
      return rules.filter((rule) => Wildcard.match(input.action, rule.action))
    }

    const evaluateInput = Effect.fnUntraced(function* (input: AssertInput, consume = false) {
      const rules = yield* configured(input.sessionID, input.agent)
      if (denied(input, rules)) return { effect: "deny" as const, rules }
      const grants = yield* sessionGrants(input.sessionID)
      if (!grants) return { effect: "deny" as const, rules, message: "Invalid stored conversation filesystem policy; revoke it in session permissions." }
      if (SessionGrant.unknownEffectsDenied(grants, input))
        return { effect: "deny" as const, rules, message: "This tool has unknown local filesystem effects which cannot be mediated under this conversation's explicit filesystem denies." }
      const decision = SessionGrant.decision(grants, input)
      if (decision === "deny") return {
        effect: "deny" as const, rules,
        message: `Conversation filesystem policy denies ${input.operations?.join("/")} at ${input.paths?.join(", ")}.`,
      }
      const listing = onceListings.findIndex((item) => item.sessionID === input.sessionID &&
        SessionGrant.decision([item.grant], input) === "allow")
      const entitlement = onceListings[listing]
      const all = [...rules, ...(yield* savedRules())]
      const effects = input.resources.map((resource) => evaluate(input.action, resource, all).effect)
      const effect: Permission.Effect = decision === "ask" ? "ask" : decision === "allow" || listing !== -1 ? "allow" : effects.includes("ask") ? "ask" : "allow"
      const event = yield* hooks.trigger("permission", "evaluate", {
        sessionID: input.sessionID,
        agent: input.agent,
        action: input.action,
        resources: input.resources,
        metadata: input.metadata,
        source: input.source,
        effect,
      })
      const unattended = yield* Unattended
      if (consume && event.effect === "allow" && decision !== "allow" && entitlement && input.action !== "external_directory") {
        const index = onceListings.indexOf(entitlement)
        if (index === -1) return { effect: "ask" as const, rules: all }
        onceListings.splice(index, 1)
      }
      if (event.effect !== "ask" || unattended === undefined)
        return { effect: event.effect, message: event.message, rules: all }
      const settled = [...all, ...unattended]
      const allowed = input.resources.every((resource) => evaluate(input.action, resource, settled).effect === "allow")
      if (allowed) return { effect: "allow" as const, rules: all }
      return {
        effect: "deny" as const,
        message: `Permission ${input.action} needs approval, and nobody is present to give it`,
        rules: all,
      }
    })

    function request(input: AssertInput, message?: string): Request {
      return {
        id: input.id ?? ID.create(),
        sessionID: input.sessionID,
        action: input.action,
        resources: input.resources,
        operations: input.operations,
        paths: input.paths,
        directories: input.directories,
        access: input.access,
        save: input.save,
        // Tools copy optional inputs straight into metadata; undefined values are not JSON and would
        // fail the HttpApi response encoder when clients list pending requests.
        metadata:
          input.metadata &&
          Object.fromEntries(Object.entries(input.metadata).filter(([, value]) => value !== undefined)),
        source: input.source,
        message,
      }
    }

    const create = (request: Request, agent?: Agent.ID) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const deferred = yield* Deferred.make<void, DeclinedError | CorrectedError>()
          const item = { request, agent, deferred }
          if (closed) {
            yield* Deferred.fail(deferred, new DeclinedError())
            return item
          }
          if (pending.has(request.id))
            return yield* Effect.die(new Error(`Duplicate pending permission ID: ${request.id}`))
          pending.set(request.id, item)
          yield* bus
            .publish(Permission.Event.Asked, request)
            .pipe(Effect.onError(() => Effect.sync(() => pending.delete(request.id))))
          // Register first, then recheck: a reply racing the initial evaluation either sees this
          // pending request in its sweep, or this check sees its new policy.
          const result = yield* evaluateInput({ ...request, agent }, true)
          if (result.effect !== "ask") {
            pending.delete(request.id)
            yield* bus.publish(Permission.Event.Replied, {
              sessionID: request.sessionID,
              requestID: request.id,
              reply: result.effect === "allow" ? "once" : "reject",
            })
            if (result.effect === "allow") yield* Deferred.succeed(deferred, undefined)
            else yield* Deferred.fail(deferred, new DeclinedError())
          }
          return item
        }).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              if (pending.get(request.id)?.request === request) pending.delete(request.id)
            }),
          ),
        ),
      )

    const ask = Effect.fn("Permission.ask")(function* (input: AssertInput) {
      if (closed) return { id: input.id ?? ID.create(), effect: "deny" as const }
      const result = yield* evaluateInput(input, true)
      const value = request(input, result.message)
      if (result.effect === "ask") yield* create(value, input.agent)
      return { id: value.id, effect: result.effect }
    })

    const assert = Effect.fn("Permission.assert")((input: AssertInput) =>
      Effect.gen(function* () {
        if (closed) return yield* Effect.die(new DeclinedError())
        const result = yield* evaluateInput(input, true)
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            if (result.effect === "deny") {
              return yield* new BlockedError({
                rules: relevant(input, result.rules),
                permission: input.action,
                resources: input.resources,
                reason: result.message,
              })
            }
            if (result.effect === "allow") return
            const item = yield* create(request(input, result.message), input.agent)
            return yield* restore(Deferred.await(item.deferred)).pipe(
              // Deliberate defect tunnel: leaves wrap execution in blanket `mapError`, which
              // must not convert a user's decline into model-facing tool output. The decline
              // resurfaces as a typed failure at SessionModelRequest.executeTool. A decline
              // WITH feedback (CorrectedError) intentionally stays typed so the leaf can turn
              // it into ToolFailure and the model continues.
              Effect.catchTag("Permission.DeclinedError", (error) => Effect.die(error)),
              Effect.ensuring(
                Effect.sync(() => {
                  pending.delete(item.request.id)
                }),
              ),
            )
          }),
        )
      }),
    )

    const assertNotDenied = Effect.fn("Permission.assertNotDenied")(function* (input: AssertInput) {
      const result = yield* evaluateInput(input)
      if (result.effect !== "deny") return
      return yield* new BlockedError({
        rules: relevant(input, result.rules),
        permission: input.action,
        resources: input.resources,
        reason: result.message,
      })
    })

    const allows = Effect.fn("Permission.allows")(function* (input: AssertInput) {
      if (closed) return false
      return (yield* evaluateInput(input)).effect === "allow"
    })

    const reply = Effect.fn("Permission.reply")((input: ReplyInput) =>
      Effect.uninterruptible(
        Effect.gen(function* () {
          const existing = pending.get(input.requestID)
          if (!existing) return yield* new NotFoundError({ requestID: input.requestID })
          const selections = yield* Effect.try({
            try: () => SessionGrant.selections(input.reply),
            catch: (error) => new Permission.InvalidPolicyError({ message: error instanceof Error ? error.message : String(error) }),
          })
          let policyRoot: SessionSchema.ID | undefined
          if (selections) {
            const directories = SessionGrant.directories(existing.request)
            if (!directories) return yield* new Permission.InvalidPolicyError({
              message: "Filesystem selections require an explicitly classified directory request; no save pattern can widen the selected scope.",
            })
            const additions = directories.flatMap((directory) => selections.map((selection) => ({ ...selection, directory })))
            policyRoot = yield* family(existing.request.sessionID)
            // Validate everything before changing storage, pending requests, or one-shot entitlements.
            const stored = yield* sessionGrants(existing.request.sessionID)
            if (!stored) return yield* new Permission.InvalidPolicyError({ message: "Invalid stored conversation filesystem policy; revoke it before applying another selection." })
            yield* persist(policyRoot, additions.filter((grant) => grant.lifetime === "session"))
            for (const grant of additions.filter((grant) => grant.lifetime === "once" && grant.scope === "parent-list"))
              onceListings.push({ sessionID: existing.request.sessionID, grant })
            const result = yield* evaluateInput({ ...existing.request, agent: existing.agent })
            const once = SessionGrant.decision([
              ...((yield* sessionGrants(existing.request.sessionID)) ?? []),
              ...additions.filter((grant) => grant.lifetime === "once" && grant.scope === "selected"),
            ], existing.request)
            // An omitted operation or a parent-list-only selection cannot approve unrelated file contents.
            if (result.effect !== "ask" || once === "allow" || once === "deny") {
              const denied = result.effect === "deny" || once === "deny"
              pending.delete(input.requestID)
              yield* bus.publish(Permission.Event.Replied, {
                sessionID: existing.request.sessionID, requestID: existing.request.id,
                reply: denied ? "reject" : input.reply,
              })
              if (denied) yield* Deferred.fail(existing.deferred, new DeclinedError())
              else yield* Deferred.succeed(existing.deferred, undefined)
            }
            for (const [id, item] of pending) {
              if ((yield* family(item.request.sessionID)) !== policyRoot) continue
              const decision = yield* evaluateInput({ ...item.request, agent: item.agent }, true)
              if (decision.effect === "ask") continue
              pending.delete(id)
              yield* bus.publish(Permission.Event.Replied, {
                sessionID: item.request.sessionID, requestID: item.request.id,
                reply: decision.effect === "deny" ? "reject" : input.reply,
              })
              if (decision.effect === "deny") yield* Deferred.fail(item.deferred, new DeclinedError())
              else yield* Deferred.succeed(item.deferred, undefined)
            }
            return
          }
          yield* bus.publish(Permission.Event.Replied, {
            sessionID: existing.request.sessionID,
            requestID: existing.request.id,
            reply: input.reply,
          })

          if (input.reply === "reject") {
            yield* Deferred.fail(
              existing.deferred,
              input.message ? new CorrectedError({ feedback: input.message }) : new DeclinedError(),
            )
            pending.delete(input.requestID)
            for (const [id, item] of pending) {
              if (item.request.sessionID !== existing.request.sessionID) continue
              yield* bus.publish(Permission.Event.Replied, {
                sessionID: item.request.sessionID,
                requestID: item.request.id,
                reply: "reject",
              })
              // Feedback applies to the whole batch, so parallel asks don't end the step.
              yield* Deferred.fail(
                item.deferred,
                input.message ? new CorrectedError({ feedback: input.message }) : new DeclinedError(),
              )
              pending.delete(id)
            }
            return
          }

          if (input.reply === "always" && existing.request.save?.length) {
            yield* saved.add({
              projectID: location.project.id,
              action: existing.request.action,
              resources: existing.request.save,
            })
          }
          yield* Deferred.succeed(existing.deferred, undefined)
          pending.delete(input.requestID)
          if (input.reply !== "always" || !existing.request.save?.length) return

          for (const [id, item] of pending) {
            const result = yield* evaluateInput({ ...item.request, agent: item.agent }).pipe(
              Effect.catchTag("Session.NotFoundError", () => Effect.undefined),
            )
            if (!result || result.effect !== "allow") continue
            yield* bus.publish(Permission.Event.Replied, {
              sessionID: item.request.sessionID,
              requestID: item.request.id,
              reply: input.reply,
            })
            yield* Deferred.succeed(item.deferred, undefined)
            pending.delete(id)
          }
        }),
      ),
    )

    const list = Effect.fn("Permission.list")(function* () {
      return Array.from(pending.values(), (item) => item.request)
    })

    const get = Effect.fn("Permission.get")(function* (id: ID) {
      return pending.get(id)?.request
    })

    const forSession = Effect.fn("Permission.forSession")(function* (sessionID: SessionSchema.ID) {
      return Array.from(pending.values(), (item) => item.request).filter((request) => request.sessionID === sessionID)
    })

    return Service.of({ ask, assert, assertNotDenied, allows, reply, get, forSession, list, close })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, Location.node, Agent.node, SessionStore.node, SessionProjector.node, PermissionSaved.node, PluginHooks.node, Database.node],
})
