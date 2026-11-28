import { createHash } from "node:crypto"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Permission as SchemaPermission } from "@opencode/schema/permission"
import type { Reply as PolicyReply, InvalidPolicyError } from "@opencode/schema/personalize/permission-contract"
import { executablePolicyError, executableScopeError, parsePolicy, readFacts, unknownExecutable, unknownExecutableScope, unknownInvocations, unknownPolicyDirectory, unknownShell, unknownZipRead, type Facts, type UnknownScope } from "@opencode/schema/personalize/permission-policy"
import { wholeCommandPattern } from "./whole-command.js"
import { SessionEvent } from "@opencode/schema/session-event"
import type { Bus } from "../bus.js"
import type { Database } from "../database/database.js"
import { EventSequenceTable } from "../event/sql.js"
import type { Permission as CorePermission } from "../permission.js"
import { SessionGrant } from "../permission/session-grant.js"
import { PermissionPolicy } from "../permission/policy.js"
import type { SessionErrors } from "../session/error.js"
import type { SessionSchema } from "../session/schema.js"
import type { SessionStore } from "../session/store.js"

export const UNKNOWN_ACTION = "__opencode_shell_unknown_v1"
class SnapshotChanged extends Error {}

type Input = CorePermission.AssertInput & Partial<Facts>
type Request = SchemaPermission.Request & Partial<Facts>
type Reply = PolicyReply
type Rules = SchemaPermission.Ruleset
type Missing = SessionErrors.NotFoundError
type Invalid = InvalidPolicyError
type EffectValue = SchemaPermission.Effect

export interface Decision {
  readonly effect: EffectValue
  readonly policy: PermissionPolicy.Policy
  readonly message?: string
}

export interface Pending {
  readonly request: Request
  /** Must be the original agent retained when the request was registered. */
  readonly agent?: Input["agent"]
}

/**
 * The host retains pending/deferreds, source-row mapping and publication.
 * `batch` claims exact entries and publishes advisory replies before `commit`.
 * `commit` validates the prospective decisions before storing authorization;
 * after it succeeds, the host performs only infallible waiter settlement.
 * The host must serialize structured replies with pending registration/rechecks.
 */
export interface PendingCallbacks {
  readonly get: (id: Request["id"]) => Effect.Effect<Pending | undefined>
  readonly list: () => Effect.Effect<readonly Pending[]>
  readonly reevaluate: (pending: Pending, consume: boolean, selected?: readonly SessionGrant.Grant[]) => Effect.Effect<Decision, Missing>
  readonly settle: (pending: Pending, effect: "allow" | "deny", reply: Reply) => Effect.Effect<boolean>
  readonly batch: (
    items: readonly { pending: Pending; effect: EffectValue }[],
    commit: (guard: () => void) => Effect.Effect<void, Missing | Invalid>,
  ) => Effect.Effect<void, Missing | Invalid | CorePermission.NotFoundError>
}

export interface Dependencies {
  readonly bus: Pick<Bus.Interface, "publishChecked">
  readonly sessions: Pick<SessionStore.Interface, "get">
  readonly db: Database.Interface["db"]
  readonly missingSession: (id: SessionSchema.ID) => Missing
  readonly invalidPolicy: (message: string) => Invalid
  readonly missingRequest: (id: Request["id"]) => CorePermission.NotFoundError
  /** Keep upstream policies opaque: flattening loses restrict/fallback semantics. */
  readonly configured: (input: Input) => Effect.Effect<PermissionPolicy.Policy, Missing>
  readonly savedPolicy: () => Effect.Effect<PermissionPolicy.Policy>
  /** Invoke the stock permission.evaluate hook, including upstream row mapping. */
  readonly evaluateEvent: (input: Input, effect: EffectValue, sourceIsRow: boolean) =>
    Effect.Effect<{ readonly effect: EffectValue; readonly message?: string }>
  readonly unattended: () => Effect.Effect<Rules | undefined>
}

export type ReplyPlan =
  | { readonly type: "delegate" }
  | { readonly type: "unknown"; readonly key: string; readonly lifetime: "once" | "session"; readonly scope?: UnknownScope }
  | { readonly type: "filesystem"; readonly additions: readonly SessionGrant.Grant[] }

/** Exact session/command/cwd/shell and current deny set, never a wildcard. */
export function unknownKey(input: Pick<Request, "action" | "sessionID" | "metadata">, grants: readonly SessionGrant.Grant[]) {
  const metadata = input.metadata
  if (input.action !== "shell" || metadata?.filesystemEffects !== "unknown" ||
    typeof metadata.unknownCommand !== "string" || typeof metadata.unknownCwd !== "string" ||
    typeof metadata.unknownShell !== "string") return undefined
  return createHash("sha256").update(JSON.stringify([
    input.sessionID, metadata.unknownCommand, metadata.unknownCwd, metadata.unknownShell,
    grants.filter((grant) => grant.effect === "deny").map((grant) => JSON.stringify(grant)).sort(),
    ...(metadata.unknownMachine === undefined ? [] : [{ machine: metadata.unknownMachine }]),
  ])).digest("hex")
}

/** SE scopes argument paths by parent; SEA opts into all arguments. */
export function unknownExecutableKey(
  input: Pick<Request, "action" | "sessionID" | "metadata">,
  grants: readonly SessionGrant.Grant[],
  scope: "executable" | "executable-all" = "executable",
) {
  const scoped = scope === "executable" ? unknownExecutableScope(input) : undefined
  const executable = scope === "executable" ? scoped?.executable : unknownExecutable(input)
  const zip = !executable && scope === "executable-all" ? unknownZipRead(input) : undefined
  const metadata = input.metadata
  if ((!executable && !zip) ||
    typeof metadata?.unknownCwd !== "string" || typeof metadata.unknownShell !== "string") return
  return createHash("sha256").update(JSON.stringify([
    zip ? "zip-entry-read-v1" : scope === "executable" ? "single-executable-args-v1" : "single-executable-v1",
    input.sessionID, zip?.recipe ?? executable, metadata.unknownCwd, metadata.unknownShell,
    ...(metadata.unknownLookup === undefined ? [] : [{ lookup: metadata.unknownLookup }]),
    ...(scoped ? [scoped.modeKey] : []),
    grants.filter((grant) => grant.effect === "deny").map((grant) => JSON.stringify(grant)).sort(),
    ...(metadata.unknownMachine === undefined ? [] : [{ machine: metadata.unknownMachine }]),
  ])).digest("hex")
}

function wholeGrant(input: Pick<Request, "action" | "sessionID" | "metadata">, grants: readonly SessionGrant.Grant[]) {
  const m = input.metadata
  if (input.action !== "shell" || m?.filesystemEffects !== "unknown" ||
    typeof m.unknownCommand !== "string" || typeof m.unknownShell !== "string" || typeof m.unknownCwd !== "string") return
  const { pattern, commands } = wholeCommandPattern(m.unknownCommand, m.unknownShell)
  const key = createHash("sha256").update(JSON.stringify([
    "whole-script-v1", input.sessionID, m.unknownShell, m.unknownCwd, m.unknownMachine, m.unknownLookup, pattern,
    grants.filter((grant) => grant.effect === "deny").map((grant) => JSON.stringify(grant)).sort(),
  ])).digest("hex")
  return { key, commands }
}

function grantKey(input: Request, grants: readonly SessionGrant.Grant[], scope?: UnknownScope) {
  if (scope === "whole") return wholeGrant(input, grants)?.key
  return scope ? unknownExecutableKey(input, grants, scope) : unknownKey(input, grants)
}

/** Reserved grants are validated, and any matching deny/ask wins over allow. */
export function unknownDecision(rules: Rules, keys: readonly string[], restrictionKeys: readonly string[] = []): EffectValue | undefined {
  const records = rules.filter((rule) => rule.action === UNKNOWN_ACTION)
  for (const rule of records) {
    if (!/^[0-9a-f]{64}$/.test(rule.resource) || !["allow", "deny", "ask"].includes(rule.effect))
      throw new Error("Invalid stored unknown-shell approval; revoke it in session permissions.")
  }
  const matching = records.filter((rule) => keys.includes(rule.resource) ||
    (rule.effect !== "allow" && restrictionKeys.includes(rule.resource)))
  if (matching.some((rule) => rule.effect === "deny")) return "deny"
  if (matching.some((rule) => rule.effect === "ask")) return "ask"
  if (matching.some((rule) => rule.effect === "allow")) return "allow"
}

/** Undefined means no change. Repeated identical selections never duplicate records. */
export function mergeGrants(previous: Rules, additions: readonly SessionGrant.Grant[]): Rules | undefined {
  if (!additions.length) return undefined
  const next = [...previous.filter((rule) => {
    if (rule.action !== SessionGrant.action) return true
    const old = SessionGrant.decode([rule])[0]
    return !old || !additions.some((grant) =>
      SessionGrant.contains(grant.directory, old.directory) && SessionGrant.contains(old.directory, grant.directory) &&
      grant.operation === old.operation && grant.scope === old.scope && grant.machine === old.machine)
  }), ...additions.map(SessionGrant.encode)]
  return JSON.stringify(previous) === JSON.stringify(next) ? undefined : next
}

export function mergeUnknown(previous: Rules, key: string): Rules | undefined {
  if (previous.some((rule) => rule.action === UNKNOWN_ACTION && rule.resource === key && rule.effect === "allow"))
    return undefined
  return [...previous, { action: UNKNOWN_ACTION, resource: key, effect: "allow" }]
}

export function makePermissionPolicy(deps: Dependencies) {
  const onceListings: { sessionID: SessionSchema.ID; grant: SessionGrant.Grant }[] = []

  const family = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
    let id = sessionID
    const seen = new Set<SessionSchema.ID>()
    while (!seen.has(id)) {
      seen.add(id)
      const session = yield* deps.sessions.get(id)
      if (!session) return yield* deps.missingSession(id)
      if (!session.parentID) return id
      id = session.parentID
    }
    return yield* deps.missingSession(id)
  })

  const sessionGrants = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
    const root = yield* family(sessionID)
    const session = yield* deps.sessions.get(root)
    // A removed root must not turn invalid or missing policy into an allow.
    if (!session) return yield* deps.missingSession(root)
    return yield* Effect.sync(() => {
      try {
        unknownDecision(session.permissions ?? [], [])
        return SessionGrant.decode(session.permissions ?? [])
      }
      catch { return undefined }
    })
  })

  // One CAS loop for both grant records and exact unknown approvals. The
  // snapshot transaction ends before bus.publish acquires its aggregate lock.
  const persist = Effect.fnUntraced(function* (
    root: SessionSchema.ID,
    merge: (previous: Rules) => Rules | undefined,
    validate: (permissions: Rules) => Effect.Effect<void, Missing | Invalid>,
    guard: () => void,
  ) {
    while (true) {
      const snapshot = yield* deps.db.transaction(
        (tx) => Effect.gen(function* () {
          const session = yield* deps.sessions.get(root)
          const sequence = yield* tx.select({ seq: EventSequenceTable.seq }).from(EventSequenceTable)
            .where(eq(EventSequenceTable.aggregate_id, root)).get()
          return { session, seq: sequence?.seq ?? -1 }
        }),
        { behavior: "immediate" },
      ).pipe(Effect.orDie)
      const session = snapshot.session
      if (!session) return yield* deps.missingSession(root)
      const permissions = yield* Effect.try({
        try: () => merge(session.permissions ?? []),
        catch: (error) => deps.invalidPolicy(error instanceof Error ? error.message : String(error)),
      })
      // Hooks and policy reads must never occur after the authorizing write.
      // Validate each CAS candidate outside the database/aggregate locks.
      yield* validate(permissions ?? session.permissions ?? [])
      yield* Effect.sync(guard)
      if (!permissions) return
      const committed = yield* deps.bus.publishChecked(SessionEvent.Permissions, { sessionID: root, permissions }, {
        // Observers can change policy. Revalidate after every proposal observer,
        // before the Bus acquires its aggregate/DB locks and writes the grant.
        check: validate(permissions).pipe(Effect.andThen(Effect.sync(guard))),
        commit: (seq) => Effect.sync(() => {
          if (seq !== snapshot.seq + 1) throw new SnapshotChanged()
          guard()
        }),
      }).pipe(
        Effect.as(true),
        Effect.catchDefect((defect) => defect instanceof SnapshotChanged
          ? Effect.succeed(false) : Effect.die(defect)),
      )
      if (committed) return
    }
  })

  const evaluate = Effect.fnUntraced(function* (
    input: Input, consume = false, sourceIsRow = false, selected: readonly SessionGrant.Grant[] = [],
    prospective?: readonly SessionGrant.Grant[],
    entitlements: typeof onceListings = onceListings,
  ) {
    const base = yield* deps.configured(input)
    if (PermissionPolicy.evaluateAll(base, input.action, input.resources) === "deny")
      return { effect: "deny", policy: base } satisfies Decision
    const stored = yield* sessionGrants(input.sessionID)
    const grants = stored && (prospective ?? stored)
    if (!grants) return {
      effect: "deny", policy: base, message: "Invalid stored conversation filesystem policy; revoke it in session permissions.",
    } satisfies Decision
    const key = unknownKey(input, grants)
    if (unknownShell(input) && !key) return {
      effect: "deny", policy: base, message: "Unknown shell effects lack an exact command, working directory, or shell.",
    } satisfies Decision
    if (key) {
      const root = yield* family(input.sessionID)
      const session = yield* deps.sessions.get(root)
      if (!session) return yield* deps.missingSession(root)
      const executableKey = unknownExecutableKey(input, grants)
      const allArgumentsKey = unknownExecutableKey(input, grants, "executable-all")
      const rules = session.permissions ?? []
      const restricted = rules.some((rule) => rule.action === UNKNOWN_ACTION && rule.effect !== "allow")
      const checkCommands = restricted || PermissionPolicy.hasDeny(base, "shell")
      const whole = checkCommands || rules.some((rule) => rule.action === UNKNOWN_ACTION) ? wholeGrant(input, grants) : undefined
      const restrictionKeys: string[] = []
      // Keep existing same-executable chain checks even for syntax the general
      // scanner treats as opaque. Segment grants are restrictions only.
      const commands = checkCommands ? whole?.commands ?? [] : []
      if (checkCommands && !commands.length)
        for (const invocation of unknownInvocations(input) ?? []) commands.push(invocation.command)
      if (commands.length) {
        if (PermissionPolicy.evaluateAll(base, "shell", commands) === "deny")
          return { effect: "deny", policy: base } satisfies Decision
        // Matching a segment can restrict a chain; a single segment's exact/SE
        // approval must never authorize the other commands in the chain.
        if (restricted) {
          for (const command of commands) {
            const part = { ...input, metadata: { ...input.metadata, unknownCommand: command } }
            const exact = unknownKey(part, grants)
            const scoped = unknownExecutableKey(part, grants)
            if (exact) restrictionKeys.push(exact)
            if (scoped) restrictionKeys.push(scoped)
            const perExecutable = unknownExecutableKey(part, grants, "executable-all")
            if (perExecutable) restrictionKeys.push(perExecutable)
          }
        }
      }
      const approval = unknownDecision(rules, [
        key, ...(executableKey ? [executableKey] : []), ...(allArgumentsKey ? [allArgumentsKey] : []), ...(whole ? [whole.key] : []),
      ], restrictionKeys)
      if (approval === "deny") return {
        effect: "deny", policy: base, message: "An explicit unknown-shell approval denial applies to this command.",
      } satisfies Decision
      if (approval === "allow")
        return { effect: "allow", policy: base } satisfies Decision
      if ((yield* deps.unattended()) !== undefined)
        return { effect: "deny", policy: base, message: "Unknown filesystem effects require an interactive approval." } satisfies Decision
      return { effect: "ask", policy: base, message: "Unknown effects: this command may bypass filesystem denies." } satisfies Decision
    }
    if (SessionGrant.unknownEffectsDenied(grants, input))
      return { effect: "deny", policy: base, message: "This tool has unknown local filesystem effects which cannot be mediated under this conversation's explicit filesystem denies." } satisfies Decision
    const decision = SessionGrant.decision([...grants, ...selected], input)
    if (decision === "deny") return {
      effect: "deny", policy: base,
      message: `Conversation filesystem policy denies ${input.operations?.join("/")} at ${input.paths?.join(", ")}.`,
    } satisfies Decision
    const entitlement = entitlements.find((item) => item.sessionID === input.sessionID &&
      SessionGrant.decision([item.grant], input) === "allow")
    const effective = PermissionPolicy.fallback(base, yield* deps.savedPolicy())
    const stockEffect = PermissionPolicy.evaluateAll(effective, input.action, input.resources)
    const effect: EffectValue = decision === "ask" ? "ask" : decision === "allow" || entitlement
      ? "allow" : stockEffect
    const event = yield* deps.evaluateEvent(input, effect, sourceIsRow)
    const unattended = yield* deps.unattended()
    if (consume && event.effect === "allow" && decision !== "allow" && entitlement && input.action !== "external_directory") {
      const index = entitlements.indexOf(entitlement)
      if (index === -1) return { effect: "ask", policy: effective } satisfies Decision
      entitlements.splice(index, 1)
    }
    if (event.effect !== "ask" || unattended === undefined)
      return { effect: event.effect, message: event.message, policy: effective } satisfies Decision
    // A hook (or owned policy) which downgraded allow must not inherit it again.
    const settled = effect === "ask" && decision !== "ask"
      ? PermissionPolicy.override(effective, unattended) : PermissionPolicy.fromRules(unattended)
    if ((effect === "ask" || input.resources.length > 0) &&
      PermissionPolicy.evaluateAll(settled, input.action, input.resources) === "allow")
      return { effect: "allow", policy: effective } satisfies Decision
    return {
      effect: "deny", policy: effective, message: `Permission ${input.action} needs approval, and nobody is present to give it`,
    } satisfies Decision
  })

  const planReply = Effect.fnUntraced(function* (request: Request, reply: Reply) {
    // Denial must still work if the session or its policy disappeared while
    // the prompt was open; stock owns ordinary message-batch rejection.
    if (reply === "reject") return { type: "delegate" } satisfies ReplyPlan
    const grants = yield* sessionGrants(request.sessionID)
    // Match the existing reply path: malformed stored policy cannot grant a
    // filesystem selection; unknown replies still require explicit validation.
    const key = unknownKey(request, grants ?? [])
    if (key) {
      if (!grants)
        return yield* deps.invalidPolicy("Invalid stored conversation filesystem policy; revoke it before approving unknown effects.")
      if (reply === "once")
        return { type: "unknown", key, lifetime: "once" } satisfies ReplyPlan
      const policy = typeof reply === "object" && "policy" in reply ? reply.policy.trim() : undefined
      if (reply === "always")
        return yield* deps.invalidPolicy("Use Unknown=1, Unknown=S, Unknown=SE, Unknown=SEA, or Whole=SEA; wildcards are not supported.")
      if (policy !== undefined) {
        const parsed = yield* Effect.try({
          try: () => parsePolicy(policy, true),
          catch: (error) => deps.invalidPolicy(error instanceof Error ? error.message : String(error)),
        })
        if (parsed.kind === "unknown") {
          const selectedKey = grantKey(request, grants, parsed.scope)
          if (!selectedKey) return yield* deps.invalidPolicy(
            unknownExecutable(request) && parsed.scope === "executable" ? executableScopeError : executablePolicyError,
          )
          return {
            type: "unknown", key: selectedKey, lifetime: parsed.lifetime,
            ...(parsed.scope ? { scope: parsed.scope } : {}),
          } satisfies ReplyPlan
        }
      }
    }
    const selections = yield* Effect.try({
      try: () => SessionGrant.selections(reply),
      catch: (error) => deps.invalidPolicy(error instanceof Error ? error.message : String(error)),
    })
    if (!selections) return { type: "delegate" } satisfies ReplyPlan
    const shellDirectory = unknownPolicyDirectory(request)
    const directories = shellDirectory
      ? ([shellDirectory.directory].filter((directory) =>
        (path.posix.isAbsolute(directory) || path.win32.isAbsolute(directory)) && !/[\0\r\n*?]/.test(directory)))
      : SessionGrant.directories(request)
    if (shellDirectory && selections.some((selection) => selection.lifetime === "once"))
      return yield* deps.invalidPolicy("Shell CRUD settings require =S or =D; use Unknown=1 for one shell invocation.")
    if (!directories?.length) return yield* deps.invalidPolicy(
      "Filesystem selections require an explicitly classified directory request; no save pattern can widen the selected scope.",
    )
    if (!grants) return yield* deps.invalidPolicy("Invalid stored conversation filesystem policy; revoke it before applying another selection.")
    const machine = shellDirectory?.machine ?? readFacts(request)?.machine
    return { type: "filesystem", additions: directories.flatMap((directory) =>
      selections.map((selection) => ({ ...selection, directory, ...(machine === undefined ? {} : { machine }) }))) } satisfies ReplyPlan
  })

  const reply = (id: Request["id"], value: Reply, pending: PendingCallbacks) =>
    Effect.uninterruptible(Effect.gen(function* () {
      const existing = yield* pending.get(id)
      if (!existing) return yield* deps.missingRequest(id)
      const plan = yield* planReply(existing.request, value)
      if (plan.type === "delegate") return plan
      if (plan.type === "unknown") {
        // An interactive approval does not override a deny installed since this
        // request was queued, or a stored policy that became invalid meanwhile.
        const current = yield* pending.reevaluate(existing, false)
        if (current.effect === "deny") {
          yield* pending.batch([{ pending: existing, effect: "deny" }], () => Effect.void)
          return plan
        }
        const root = yield* family(existing.request.sessionID)
        const validate = Effect.gen(function* () {
          const grants = yield* sessionGrants(existing.request.sessionID)
          const currentKey = grants && grantKey(existing.request, grants, plan.scope)
          const current = yield* pending.reevaluate(existing, false)
          if (currentKey !== plan.key || current.effect === "deny")
            return yield* deps.invalidPolicy("Permission changed while approving; review the renewed request.")
        })
        const persistApproval = (guard: () => void) => plan.lifetime === "session"
          ? persist(root, (previous) => {
            unknownDecision(previous, [])
            const grants = SessionGrant.decode(previous)
            const key = grantKey(existing.request, grants, plan.scope)
            if (key !== plan.key)
              throw new Error("Filesystem denies changed while approving this command; review and approve again.")
            const stored = unknownDecision(previous, [key])
            if (stored === "deny" || stored === "ask")
              throw new Error("An explicit stored unknown-shell ask/deny rule must be revoked before approving this command.")
            return mergeUnknown(previous, plan.key)
          }, () => validate, guard) : validate.pipe(Effect.andThen(Effect.sync(guard)))
        yield* pending.batch([{ pending: existing, effect: "allow" }], persistApproval)
        return plan
      }
      const root = yield* family(existing.request.sessionID)
      const session = yield* deps.sessions.get(root)
      if (!session) return yield* deps.missingSession(root)
      const durable = plan.additions.filter((grant) => grant.lifetime === "session")
      const selected = plan.additions.filter((grant) => grant.lifetime === "once" && grant.scope === "selected")
      const listings = plan.additions.filter((grant) => grant.lifetime === "once" && grant.scope === "parent-list")
      const prospective = yield* Effect.try({
        try: () => SessionGrant.decode(mergeGrants(session.permissions ?? [], durable) ?? session.permissions ?? []),
        catch: (error) => deps.invalidPolicy(error instanceof Error ? error.message : String(error)),
      })
      const items: { pending: Pending; effect: EffectValue }[] = []
      const addedListings = listings.map((grant) => ({
        sessionID: existing.request.sessionID, grant,
      }))
      const entitlements = () => [...onceListings, ...addedListings]
      const previewListings = entitlements()
      const preview = (item: Pending) => evaluate(
        { ...item.request, agent: item.agent }, true, true,
        item.request.id === existing.request.id ? selected : [], prospective, previewListings,
      )
      const result = yield* preview(existing)
      // Even a partial policy must retain a claim on its originating request:
      // cancellation must invalidate its write although the prompt stays open.
      items.push({ pending: existing, effect: result.effect })
      for (const item of yield* pending.list()) {
        if (item.request.id === existing.request.id) continue
        if ((yield* family(item.request.sessionID)) !== root) continue
        const decision = yield* preview(item)
        if (decision.effect !== "ask") items.push({ pending: item, effect: decision.effect })
      }
      const commit = (guard: () => void) => Effect.gen(function* () {
        let remaining = entitlements()
        let reserved: typeof onceListings = []
        yield* persist(root, (previous) => mergeGrants(previous, durable), (permissions) => Effect.gen(function* () {
          const grants = yield* Effect.try({
            try: () => SessionGrant.decode(permissions),
            catch: (error) => deps.invalidPolicy(error instanceof Error ? error.message : String(error)),
          })
          remaining = entitlements()
          const available = [...remaining]
          for (const { pending: item, effect } of items) {
            const current = yield* evaluate(
              { ...item.request, agent: item.agent }, true, true,
              item.request.id === existing.request.id ? selected : [], grants, remaining,
            )
            if (current.effect !== effect)
              return yield* deps.invalidPolicy("Permission changed while approving; review the renewed request.")
          }
          reserved = available.filter((item) => !remaining.includes(item) && !addedListings.includes(item))
        }), () => {
          guard()
          if (reserved.some((item) => !onceListings.includes(item)))
            throw new Error("A one-shot listing was consumed during approval; review the renewed request.")
        })
        // In-memory one-shot entitlements become visible only after every
        // fallible operation succeeds. Failed candidates consume nothing.
        // Apply an identity delta, never restore a stale snapshot over a
        // reentrant consumption by a permission hook.
        for (const item of reserved) {
          const index = onceListings.indexOf(item)
          if (index >= 0) onceListings.splice(index, 1)
        }
        onceListings.push(...addedListings.filter((item) => remaining.includes(item)))
      })
      yield* pending.batch(items, commit)
      return plan
    }))

  return {
    family, sessionGrants, evaluate, planReply, reply,
    /** Call from the host service's scope finalizer. */
    close: () => { onceListings.length = 0 },
  }
}
