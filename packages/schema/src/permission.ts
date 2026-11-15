export * as Permission from "./permission.js"

import { Schema } from "effect"
import { optional } from "./schema.js"
import { ephemeral, inventory } from "./event.js"
import { ascending } from "./identifier.js"
import { SessionID } from "./session-id.js"
import { statics } from "./schema.js"

export const ID = Schema.String.check(Schema.isStartingWith("per")).pipe(
  Schema.brand("Permission.ID"),
  Schema.annotate({ identifier: "Permission.ID" }),
  statics((schema) => ({ create: (id?: string) => schema.make(id ?? "per_" + ascending()) })),
)
export type ID = typeof ID.Type

export const Source = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("tool"),
    messageID: Schema.String,
    id: Schema.String,
  }),
]).annotate({ identifier: "Permission.Source" })
export type Source = typeof Source.Type

export const Operation = Schema.Literals(["read", "create", "update", "delete"]).annotate({
  identifier: "Permission.Operation",
})
export type Operation = typeof Operation.Type

const RequestFields = {
  sessionID: SessionID,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  /** Explicit filesystem needs. Omitted for shell and unclassified requests. */
  operations: Schema.Array(Operation).pipe(optional),
  /** Absolute lexical paths; never patterns or tool search expressions. */
  paths: Schema.Array(Schema.String).pipe(optional),
  /** Exact directory boundaries offered in the prompt, independent of persistent save patterns. */
  directories: Schema.Array(Schema.String).pipe(optional),
  /** Listing is distinct from reading file contents (including grep/glob traversal). */
  access: Schema.Literals(["content", "listing"]).pipe(optional),
  save: Schema.Array(Schema.String).pipe(optional),
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
  source: Source.pipe(optional),
  message: Schema.String.pipe(optional),
}

export const Request = Schema.Struct({
  id: ID,
  ...RequestFields,
}).annotate({ identifier: "Permission.Request" })
export interface Request extends Schema.Schema.Type<typeof Request> {}

export const SessionPolicy = Schema.Struct({
  scope: Schema.Literal("session"),
  read: Schema.Literals(["allow", "ask", "deny"]),
  create: Schema.Literals(["allow", "ask", "deny"]),
  update: Schema.Literals(["allow", "ask", "deny"]),
  delete: Schema.Literals(["allow", "ask", "deny"]),
  /** Omitted means all four operations apply recursively to the displayed subtree. */
  recursive: Schema.Array(Operation).pipe(optional),
}).annotate({ identifier: "Permission.SessionPolicy" })
export interface SessionPolicy extends Schema.Schema.Type<typeof SessionPolicy> {}

export const CompactPolicy = Schema.Struct({
  scope: Schema.Literal("session"),
  /** CRUD only, e.g. "RU=S* CD=D*". Contradictions and other tool switches are rejected. */
  policy: Schema.String,
}).annotate({ identifier: "Permission.CompactPolicy" })
export interface CompactPolicy extends Schema.Schema.Type<typeof CompactPolicy> {}

export const Selection = Schema.Struct({
  operation: Operation,
  effect: Schema.Literals(["allow", "deny", "ask"]),
  lifetime: Schema.Literals(["once", "session"]),
  recursive: Schema.Boolean,
  scope: Schema.Literals(["selected", "parent-list"]),
}).annotate({ identifier: "Permission.Selection" })
export interface Selection extends Schema.Schema.Type<typeof Selection> {}
export const StructuredPolicy = Schema.Struct({
  scope: Schema.Literal("session"),
  rules: Schema.Array(Selection),
}).annotate({ identifier: "Permission.StructuredPolicy" })
export interface StructuredPolicy extends Schema.Schema.Type<typeof StructuredPolicy> {}

export class InvalidPolicyError extends Schema.TaggedError<InvalidPolicyError>()(
  "Permission.InvalidPolicyError",
  { message: Schema.String },
  { httpApiStatus: 400 },
) {}

export const Reply = Schema.Union([Schema.Literals([
  "once", "always", "reject",
  "session_read", "session_create", "session_update", "session_delete", "session_crud",
]), SessionPolicy, CompactPolicy, StructuredPolicy]).annotate({ identifier: "Permission.Reply" })
export type Reply = typeof Reply.Type

const Asked = ephemeral({ type: "permission.asked", schema: Request.fields })
const Replied = ephemeral({
  type: "permission.replied",
  schema: {
    sessionID: SessionID,
    requestID: ID,
    reply: Reply,
  },
})
export const Event = { Asked, Replied, Definitions: inventory(Asked, Replied) }

export const Effect = Schema.Literals(["allow", "deny", "ask"]).annotate({ identifier: "Permission.Effect" })
export type Effect = typeof Effect.Type

export interface Rule extends Schema.Schema.Type<typeof Rule> {}
export const Rule = Schema.Struct({
  action: Schema.String,
  resource: Schema.String,
  effect: Effect,
}).annotate({ identifier: "Permission.Rule" })

export const Ruleset = Schema.Array(Rule).annotate({ identifier: "Permission.Ruleset" })
export type Ruleset = typeof Ruleset.Type
