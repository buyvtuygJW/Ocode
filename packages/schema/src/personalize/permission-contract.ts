import { Schema } from "effect"
import { optional } from "../schema.js"

/** Owned reply vocabulary. Request facts use stock metadata, not extra wire fields. */
// Keep implementation shapes inline in the wire Reply schema. They remain
// exported here for runtime/type reuse, without separate generated SDK models.
export const Operation = Schema.Literals(["read", "create", "update", "delete"])
export type Operation = typeof Operation.Type

export const SessionPolicy = Schema.Struct({
  scope: Schema.Literal("session"),
  read: Schema.Literals(["allow", "ask", "deny"]),
  create: Schema.Literals(["allow", "ask", "deny"]),
  update: Schema.Literals(["allow", "ask", "deny"]),
  delete: Schema.Literals(["allow", "ask", "deny"]),
  /** Omitted means all four operations apply recursively to the displayed subtree. */
  recursive: Schema.Array(Operation).pipe(optional),
})
export interface SessionPolicy extends Schema.Schema.Type<typeof SessionPolicy> {}

export const CompactPolicy = Schema.Struct({
  scope: Schema.Literal("session"),
  policy: Schema.String,
})
export interface CompactPolicy extends Schema.Schema.Type<typeof CompactPolicy> {}

export const Selection = Schema.Struct({
  operation: Operation,
  effect: Schema.Literals(["allow", "deny", "ask"]),
  lifetime: Schema.Literals(["once", "session"]),
  recursive: Schema.Boolean,
  scope: Schema.Literals(["selected", "parent-list"]),
})
export interface Selection extends Schema.Schema.Type<typeof Selection> {}

export const StructuredPolicy = Schema.Struct({
  scope: Schema.Literal("session"),
  rules: Schema.Array(Selection),
})
export interface StructuredPolicy extends Schema.Schema.Type<typeof StructuredPolicy> {}

export class InvalidPolicyError extends Schema.TaggedError<InvalidPolicyError>()(
  "Permission.InvalidPolicyError",
  { message: Schema.String },
  { identifier: "PermissionInvalidPolicyError", httpApiStatus: 400 },
) {}

export const Reply = Schema.Union([
  Schema.Literals([
    "once", "always", "reject",
    "session_read", "session_create", "session_update", "session_delete", "session_crud",
  ]),
  SessionPolicy, CompactPolicy, StructuredPolicy,
]).annotate({ identifier: "Permission.Reply" })
export type Reply = typeof Reply.Type
