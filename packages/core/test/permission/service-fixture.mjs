import assert from "node:assert/strict"
import { Context, Effect, Schema, Semaphore } from "effect"

const service = (name) => Context.Service(`permission-node-test/${name}`)
export const Agent = { Service: service("Agent"), node: {}, ID: Schema.String }
export const Bus = { Service: service("Bus"), node: {} }
export const Location = { Service: service("Location"), node: {} }
export const SessionStore = { Service: service("SessionStore"), node: {} }
export const SessionProjector = { node: {} }
export const PermissionSaved = { Service: service("PermissionSaved"), node: {} }
export const PluginHooks = { Service: service("PluginHooks"), node: {} }
export const Database = { Service: service("Database"), node: {} }
export const Project = { ID: { global: "prj_global" } }
export const SessionSchema = { ID: Schema.String }
export const makeLocationNode = (input) => input
export const eq = (field, value) => ({ field, value })
export const SessionErrors = {
  NotFoundError: class extends Schema.TaggedError()("Session.NotFoundError", { sessionID: Schema.String }) {},
}

// These builders evaluate the *actual* SQL declarations, retaining their actual keys.
// They are not a SQL driver; no handwritten SessionTable shape can hide a misspelled column.
function column(name) {
  const chain = {
    name: typeof name === "string" ? name : undefined,
    $type: () => chain, primaryKey: () => chain, notNull: () => chain,
    references: () => chain, default: () => chain, $default: () => chain,
  }
  return chain
}
export const blob = column
export const text = column
export const integer = column
export const real = column
export const pathColumn = column
export const directoryColumn = column
export const Timestamps = {}
export const ProjectTable = { id: column() }
export const sql = () => ({})
export const index = () => ({ on: () => ({ where: () => ({}) }) })
export const uniqueIndex = index
export const primaryKey = () => ({})
export function sqliteTable(name, columns) {
  for (const [key, value] of Object.entries(columns)) Object.assign(value, { name: value.name ?? key, table: name })
  return columns
}

const clone = (value) => JSON.parse(JSON.stringify(value))

// Explicit synthetic-storage boundary: production Permission logic and SQL declarations,
// but a serialized in-memory transaction/event/projector adapter rather than native SQLite/Bus.
export function fixture(SessionTable, EventSequenceTable) {
  assert.ok(SessionTable.permission, "actual session/sql.ts must expose permission")
  assert.equal(SessionTable.permission.name, "permission")
  assert.equal(SessionTable.permissions, undefined, "plural permissions is not a projected SQL column")
  const records = new Map() // SessionStore domain records, not SQL column definitions.
  const sequences = new Map()
  const durable = []
  const trace = []
  const agentRules = []
  const saved = []
  const events = []
  const databaseLock = Semaphore.makeUnsafe(1)
  const aggregateLock = Semaphore.makeUnsafe(1)
  let onPublish
  let afterSnapshot
  let readSnapshot = false
  let transactionDepth = 0

  const project = (type, payload) => {
    const session = records.get(payload.sessionID)
    assert.ok(session)
    if (type === "session.permissions") {
      // Match SessionEvent.Permissions' real projector mapping: SQL permission -> domain permissions.
      const row = { [SessionTable.permission.name]: clone(payload.permissions) }
      records.set(payload.sessionID, { ...session, permissions: row.permission })
      trace.push("project:permission")
    } else if (type === "session.metadata.updated") {
      records.set(payload.sessionID, { ...session, metadata: clone(payload.metadata) })
    } else {
      throw new Error(`Unexpected durable event ${type}`)
    }
  }
  const db = {
    transaction(body, config) {
      assert.equal(config?.behavior, "immediate")
      const transaction = databaseLock.withPermit(Effect.gen(function* () {
        const previous = clone([...records])
        const previousSequences = [...sequences]
        const previousDurable = clone(durable)
        trace.push("begin")
        transactionDepth++
        readSnapshot = false
        let wasRead = false
        const result = yield* body(db).pipe(
          Effect.tap(() => Effect.sync(() => { wasRead = readSnapshot })),
          Effect.onError(() => Effect.sync(() => {
            records.clear()
            for (const [id, value] of previous) records.set(id, value)
            sequences.clear()
            for (const [id, value] of previousSequences) sequences.set(id, value)
            durable.splice(0, durable.length, ...previousDurable)
            trace.push("rollback")
          })),
          Effect.ensuring(Effect.sync(() => { transactionDepth-- })),
        )
        trace.push("commit")
        return { result, wasRead }
      }))
      return transaction.pipe(Effect.flatMap(({ result, wasRead }) => Effect.gen(function* () {
        if (wasRead && afterSnapshot) {
          const hook = afterSnapshot
          afterSnapshot = undefined
          yield* hook()
        }
        return result
      })))
    },
    select(fields) {
      assert.equal(fields.seq, EventSequenceTable.seq)
      return {
        from(table) {
          assert.equal(table, EventSequenceTable)
          return {
            where(condition) {
              assert.equal(condition.field, EventSequenceTable.aggregate_id)
              return { get: () => Effect.sync(() => {
                assert.equal(transactionDepth, 1, "sequence read must share the session snapshot transaction")
                readSnapshot = true
                trace.push("read:aggregate-sequence")
                const seq = sequences.get(condition.value)
                return seq === undefined ? undefined : { seq }
              }) }
            },
          }
        },
      }
    },
    // Deliberately no update(): Permission must not mutate the projection directly.
  }
  const publish = (event, payload, options) => Effect.gen(function* () {
    if (event.durable) {
      assert.equal(transactionDepth, 0, "never acquire the Bus aggregate lock inside a database transaction")
      yield* aggregateLock.withPermit(db.transaction(() => Effect.gen(function* () {
        const seq = (sequences.get(payload.sessionID) ?? -1) + 1
        project(event.type, payload)
        if (options?.commit) {
          trace.push("durable:commit-check")
          yield* options.commit(seq)
        }
        sequences.set(payload.sessionID, seq)
        durable.push(clone({ type: event.type, seq, data: payload }))
        trace.push("durable:append")
      }), { behavior: "immediate" }))
    }
    events.push({ event, payload })
    trace.push(`notify:${event.type}`)
    if (onPublish) yield* onPublish(payload)
  })
  return {
    records, saved, events, agentRules, durable, sequences, trace,
    add(id, parentID) { records.set(id, { id, parentID, permissions: [] }) },
    publish(callback) { onPublish = callback },
    afterSnapshot(callback) { afterSnapshot = callback },
    publishDurable: publish,
    replay() {
      const log = clone(durable)
      for (const [id, session] of records) records.set(id, { ...session, permissions: [] })
      for (const event of log) project(event.type, event.data)
    },
    services: [
      [Agent.Service, { resolve: () => Effect.sync(() => ({ permissions: [...agentRules] })) }],
      [Bus.Service, { publish }],
      [Location.Service, { project: { id: "prj_test" }, directory: "D:/work" }],
      [SessionStore.Service, { get: (id) => Effect.sync(() => {
        if (transactionDepth) trace.push("read:session")
        const record = records.get(id)
        return record && clone(record)
      }) }],
      [PermissionSaved.Service, {
        list: ({ projectID }) => Effect.sync(() => saved.filter((rule) => rule.projectID === projectID)),
        add: ({ projectID, action, resources }) => Effect.sync(() => {
          saved.push(...resources.map((resource) => ({ projectID, action, resource })))
        }),
      }],
      [PluginHooks.Service, { trigger: (_namespace, _event, input) => Effect.succeed(input) }],
      [Database.Service, { db }],
    ],
  }
}
