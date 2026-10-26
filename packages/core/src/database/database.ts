export * as Database from "./database.js"

import { EffectDrizzleSqlite } from "./drizzle.js"
import { sqliteLayer, supportsForeignKeyToggle, supportsTuningPragmas } from "#sqlite"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import type { SqlClient } from "effect/sql"
import { Global } from "@opencode/util/global"
import { closeSync, existsSync, openSync, statSync, unlinkSync } from "node:fs"
import { chmod } from "node:fs/promises"
import { isAbsolute, join } from "path"
import { DatabaseMigration } from "./migration.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export const Options = Schema.Struct({
  path: Schema.optional(Schema.String),
})
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, Interface>()("@opencode/storage/Database") {}

// The bootstrap lock is scoped to the database being built, never to this
// module: on workerd every Durable Object in an isolate shares module state, and
// releasing a shared semaphore resumes the waiting object's fiber inside the
// releasing object's I/O context, where its first storage call is rejected as
// cross-object I/O.
const databaseLayer = (
  lock: Effect.Effect<Semaphore.Semaphore>,
  guard?: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = yield* makeDatabase

      const bootstrap = Effect.gen(function* () {
        if (supportsTuningPragmas) {
          yield* db.run("PRAGMA journal_mode = WAL")
          yield* db.run("PRAGMA synchronous = NORMAL")
          yield* db.run("PRAGMA busy_timeout = 5000")
          yield* db.run("PRAGMA cache_size = -64000")
          yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
        }
        // Durable Object SQLite always enforces foreign keys and rejects the pragma.
        if (supportsForeignKeyToggle) yield* db.run("PRAGMA foreign_keys = ON")
        const semaphore = yield* lock
        yield* semaphore.withPermit(DatabaseMigration.apply(db))
      })
      yield* (guard ? guard(bootstrap) : bootstrap)

      return { db }
    }).pipe(Effect.orDie),
  )

// The in-process semaphore above cannot serialize two PROCESSES. Two instances
// launched in the same second race first-boot setup of a shared database file:
// `PRAGMA journal_mode = WAL` runs before busy_timeout is set, and the
// migration's first write after a shared read snapshot fails with SQLITE_BUSY
// immediately (a snapshot upgrade is not retried by busy_timeout). The loser
// then dies -- or, in the TUI, hangs as an unrendered pane. File-backed
// databases therefore guard first-boot setup with an exclusive lockfile next to
// the database. Only `layer()` (a filesystem runtime) constructs the guard;
// workerd goes through layerFromClient and never touches node:fs here.
const BOOT_LOCK_STALE_MS = 60_000
const BOOT_LOCK_WAIT_MS = 120_000

async function acquireBootLock(lockfile: string) {
  const started = Date.now()
  for (;;) {
    try {
      return openSync(lockfile, "wx", 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    }
    try {
      // A holder that crashed before unlinking leaves the lockfile behind: steal it
      // once stale. On Windows the unlink fails while a live holder keeps the file
      // open, which is exactly the keep-waiting case.
      if (Date.now() - statSync(lockfile).mtimeMs > BOOT_LOCK_STALE_MS) unlinkSync(lockfile)
    } catch {}
    if (Date.now() - started > BOOT_LOCK_WAIT_MS)
      throw new Error(`timed out waiting for database bootstrap lock: ${lockfile}`)
    await new Promise((resolve) => setTimeout(resolve, 100 + Math.floor(Math.random() * 150)))
  }
}

const withBootLock =
  (lockfile: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      Effect.promise(() => acquireBootLock(lockfile)),
      () => effect,
      (fd) =>
        Effect.sync(() => {
          try {
            closeSync(fd)
          } catch {}
          try {
            unlinkSync(lockfile)
          } catch {}
        }),
    )

// Two instances over one file bootstrap the same schema, so file databases
// share a lock per path. Each in-memory database is its own connection.
const locks = new Map<string, Semaphore.Semaphore>()

function lockFor(filename: string) {
  const existing = locks.get(filename)
  if (existing) return existing
  const lock = Semaphore.makeUnsafe(1)
  locks.set(filename, lock)
  return lock
}

export function layer(options: Options = { path: ":memory:" }) {
  return Layer.unwrap(
    Effect.gen(function* () {
      const provide = (filename: string) =>
        databaseLayer(
          filename === ":memory:" ? Semaphore.make(1) : Effect.succeed(lockFor(filename)),
          filename === ":memory:" ? undefined : withBootLock(`${filename}.boot.lock`),
        ).pipe(Layer.provide(sqliteLayer({ filename })))
      const filename = options.path ?? ":memory:"
      if (filename === ":memory:") return provide(filename)
      const file = isAbsolute(filename) ? filename : join((yield* Global.Service).data, filename)
      yield* Effect.promise(() => restrictToOwner(file))
      return provide(file)
    }),
  )
}

// SQLite creates new sidecars with the database's mode, but does not tighten existing sidecars.
// Windows relies on the user profile directory's inherited ACLs instead of POSIX modes.
async function restrictToOwner(filename: string) {
  if (process.platform === "win32") return
  // Opening and closing an existing database can release another connection's POSIX locks.
  // Create missing files synchronously so another fiber cannot open one before it is restricted.
  if (!existsSync(filename)) closeSync(openSync(filename, "a", 0o600))
  await chmod(filename, 0o600)
  await Promise.all(
    [`${filename}-wal`, `${filename}-shm`].map((file) =>
      chmod(file, 0o600).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
      }),
    ),
  )
}

// The database service over an injected SqlClient, for runtimes that receive
// database storage instead of opening a filesystem path. Any client provided
// here still goes through the pragma guards and migrations; Global is required
// because migrations may read it (the v1 import). The lock is created per build
// because every Durable Object builds this layer over its own storage.
export const layerFromClient: Layer.Layer<Service, never, SqlClient.SqlClient | Global.Service> = databaseLayer(
  Semaphore.make(1),
)

export function configured(options?: Options) {
  return makeGlobalNode({ service: Service, layer: layer(options), deps: [Global.node] })
}

/** `configured`, but over an injected SqlClient layer instead of a filesystem path. */
export function configuredClient(client: Layer.Layer<SqlClient.SqlClient>) {
  return makeGlobalNode({
    service: Service,
    layer: layerFromClient.pipe(Layer.provide(client)),
    deps: [Global.node],
  })
}

export const node = configured({ path: ":memory:" })
