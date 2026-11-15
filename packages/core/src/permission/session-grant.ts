export * as SessionGrant from "./session-grant.js"

import path from "node:path"
import type { Permission } from "@opencode/schema/permission"
import { parsePermissionShorthand } from "@opencode/schema/permission-shorthand"

/** Stored only in the root Session.permissions. Ordinary action matching must ignore this action. */
export const action = "__opencode_filesystem_session_v1"
export interface Grant extends Permission.Selection {
  readonly directory: string
}
type Input = Pick<Permission.Request, "action" | "operations" | "paths" | "access" | "metadata">

export function selections(reply: Permission.Reply): readonly Permission.Selection[] | undefined {
  if (typeof reply === "object") {
    if ("rules" in reply) return validate(reply.rules)
    if ("policy" in reply) {
      const parsed = parsePermissionShorthand(reply.policy)
      if (parsed.mcp !== undefined) throw new Error("MCP selection belongs to tool configuration, not a directory permission grant.")
      return validate(parsed.filesystem)
    }
    return validate((["read", "create", "update", "delete"] as const).flatMap((operation) =>
      reply[operation] === "ask" ? [] : [{
        operation, effect: reply[operation], lifetime: "session" as const,
        recursive: reply.recursive?.includes(operation) ?? true, scope: "selected" as const,
      }]))
  }
  const operations: readonly Permission.Operation[] | undefined = reply === "session_read" ? ["read"]
    : reply === "session_create" ? ["create"] : reply === "session_update" ? ["update"]
    : reply === "session_delete" ? ["delete"] : reply === "session_crud" ? ["read", "create", "update", "delete"] : undefined
  return operations?.map((operation) => ({
    operation, effect: "allow", lifetime: "session", recursive: true, scope: "selected",
  }))
}

export function validate(rules: readonly Permission.Selection[]) {
  if (!rules.length) throw new Error("Select at least one filesystem operation.")
  const seen = new Set<Permission.Operation>()
  for (const rule of rules) {
    if (seen.has(rule.operation)) throw new Error(`Duplicate or contradictory policy for ${rule.operation}.`)
    seen.add(rule.operation)
    if (rule.scope === "parent-list" && (rule.operation !== "read" || rule.recursive || rule.effect !== "allow"))
      throw new Error("Parent-list scope is valid only for nonrecursive read allows.")
  }
  return rules
}

function normalize(value: string) {
  const windows = /^[a-z]:[\\/]/i.test(value) || value.startsWith("\\\\") || value.startsWith("//")
  const normalized = (windows ? path.win32.normalize(value) : path.posix.normalize(value)).replaceAll("\\", "/")
  return (windows ? normalized.toLowerCase() : normalized).replace(/\/+$/, "")
}
export function contains(directory: string, target: string) {
  const root = normalize(directory)
  const file = normalize(target)
  return file === root || file.startsWith(`${root}/`)
}
export function parent(directory: string) {
  return (/^[a-z]:[\\/]/i.test(directory) || directory.startsWith("\\\\")
    ? path.win32.dirname(directory) : path.posix.dirname(directory)).replaceAll("\\", "/")
}
export function needs(input: Input) {
  if (!["external_directory", "read", "edit", "glob", "grep", "list"].includes(input.action)) return false
  if (!input.operations?.length || !input.paths?.length) return false
  return input.action === "external_directory" || input.action === "edit" ||
    input.operations.every((operation) => operation === "read")
}
function matches(grant: Grant, input: Input, target: string) {
  if (grant.scope === "parent-list")
    return input.access === "listing" && normalize(target) === normalize(parent(grant.directory))
  // Search leaves inspect descendants, not just their root. Narrow allows cannot
  // authorize that traversal, and nested denies/asks still constrain it.
  if (input.metadata?.filesystemReadScope === "recursive") {
    if (grant.effect === "allow") return grant.recursive && contains(grant.directory, target)
    if (contains(target, grant.directory)) return true
  }
  return grant.recursive ? contains(grant.directory, target) : normalize(grant.directory) === normalize(target) ||
    normalize(parent(target)) === normalize(grant.directory)
}
export function decision(grants: readonly Grant[], input: Input): Permission.Effect | undefined {
  if (!needs(input)) return
  const effects = input.operations!.flatMap((operation) => input.paths!.map((target) => {
    const candidates = grants.filter((grant) => grant.operation === operation && matches(grant, input, target))
    if (candidates.some((grant) => grant.effect === "deny")) return "deny"
    if (candidates.some((grant) => grant.effect === "ask")) return "explicit-ask"
    if (candidates.some((grant) => grant.effect === "allow")) return "allow"
    return "ask"
  }))
  if (effects.includes("deny")) return "deny"
  if (effects.includes("explicit-ask")) return "ask"
  if (effects.every((effect) => effect === "allow")) return "allow"
}
export function unknownEffectsDenied(grants: readonly Grant[], input: Input) {
  return input.metadata?.filesystemEffects === "unknown" && grants.some((grant) => grant.effect === "deny")
}
/** Selected resources are precisely the displayed directories, never save patterns. */
export function directories(input: Permission.Request): string[] | undefined {
  if (!needs(input)) return
  if (!input.directories && (input.action !== "external_directory" || !input.resources.length ||
    !input.resources.every((resource) => resource.endsWith("/*")))) return
  const result = input.directories ? [...input.directories] : input.resources.map((resource) => resource.slice(0, -2))
  if (!result.length || result.some((directory) => !path.posix.isAbsolute(directory) && !path.win32.isAbsolute(directory))) return
  if (result.some((directory) => /[*?]/.test(directory))) return
  if (!input.paths!.every((target) => result.some((directory) => contains(directory, target)))) return
  return result
}
export function encode(grant: Grant): Permission.Rule {
  return { action, resource: JSON.stringify(grant), effect: grant.effect }
}
/** Invalid reserved records fail closed rather than silently granting filesystem access. */
export function decode(rules: Permission.Ruleset): Grant[] {
  return rules.filter((rule) => rule.action === action).map((rule): Grant => {
    const value: unknown = JSON.parse(rule.resource)
    if (!value || typeof value !== "object" || !("directory" in value) || typeof value.directory !== "string" ||
      !("operation" in value) || !["read", "create", "update", "delete"].includes(String(value.operation)) ||
      !("effect" in value) || !["allow", "deny", "ask"].includes(String(value.effect)) ||
      !("lifetime" in value) || value.lifetime !== "session" ||
      !("recursive" in value) || typeof value.recursive !== "boolean" ||
      !("scope" in value) || !["selected", "parent-list"].includes(String(value.scope)))
      throw new Error("Invalid stored conversation filesystem policy. Revoke it using session permissions.")
    // Decode each public field without an unchecked cast.
    const operation = value.operation
    const effect = value.effect
    const scope = value.scope
    if ((operation !== "read" && operation !== "create" && operation !== "update" && operation !== "delete") ||
      (effect !== "allow" && effect !== "deny" && effect !== "ask") ||
      (scope !== "selected" && scope !== "parent-list")) throw new Error("Invalid stored filesystem policy.")
    if (effect !== rule.effect) throw new Error("Stored filesystem policy effect disagrees with its permission rule.")
    return { operation, effect, scope, lifetime: "session", recursive: value.recursive, directory: value.directory }
  })
}
