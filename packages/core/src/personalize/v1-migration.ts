import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "../database/database"
import { Project } from "@opencode/schema/project"

export function decorate(stock: typeof import("../database/v1-migration.bun")) {
  const run: typeof stock.run = (options) => Effect.gen(function* () {
    const result = yield* stock.run(options)
    const db = (yield* Database.Service).db
    yield* db.transaction((tx) => tx.run(sql`
      UPDATE session_v2 SET
        project_id = (SELECT w.project_id FROM worktree w
          WHERE session_v2.directory = w.directory
             OR substr(session_v2.directory, 1, length(w.directory) + 1) = w.directory || '/'
          ORDER BY length(w.directory) DESC LIMIT 1),
        path = (SELECT ltrim(substr(session_v2.directory, length(w.directory) + 1), '/') FROM worktree w
          WHERE session_v2.directory = w.directory
             OR substr(session_v2.directory, 1, length(w.directory) + 1) = w.directory || '/'
          ORDER BY length(w.directory) DESC LIMIT 1)
      WHERE project_id = ${Project.ID.global} AND workspace_id IS NULL AND EXISTS (
        SELECT 1 FROM worktree w WHERE session_v2.directory = w.directory
          OR substr(session_v2.directory, 1, length(w.directory) + 1) = w.directory || '/')
    `)).pipe(Effect.orDie)
    return result
  })
  // Keep upstream's progress/status layer. Its migration lock makes the second
  // call idempotent; this tail always performs adoption, including already-imported V1 data.
  const layer = Layer.merge(stock.layer, Layer.effectDiscard(run().pipe(
    Effect.catchCause((cause) => Effect.logError("Personalize V1 adoption failed", { cause })),
    Effect.forkScoped({ startImmediately: true }),
  )))
  return { run, layer }
}
