import { Context, DateTime, Effect, Layer } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { SessionStore } from "../session/store.js"
import { isExactRootFallback } from "@opencode/util/session-title-fallback"
import { dateTitle, renameIfUnchanged } from "./session-naming"

// Compose the public service, never copy or transform stock create's internals.
// These services already belong to Session.node's dependency graph.
// mapLayer's generic R cannot express those existing requirements; the final
// cast preserves that stock contract without introducing a new graph edge.
export function decorate(stock: typeof import("../session")) {
  return { node: stock.node.mapLayer((layer) => layer.pipe(Layer.flatMap((context) =>
    Layer.effect(stock.Service, Effect.gen(function* () {
      const original = Context.get(context, stock.Service)
      const bus = yield* Bus.Service
      const database = yield* Database.Service
      const store = yield* SessionStore.Service
      const create: typeof original.create = (input) => original.create(input).pipe(Effect.flatMap((session) => {
        // Explicit titles (including child/council names) remain untouched.
        if (input.title !== undefined || session.parentID || !isExactRootFallback({
          title: session.title, time: { created: DateTime.toEpochMillis(session.time.created) },
        })) return Effect.succeed(session)
        return renameIfUnchanged(session, dateTitle(session.time.created)).pipe(
          Effect.provideService(Bus.Service, bus),
          Effect.provideService(Database.Service, database),
          Effect.provideService(SessionStore.Service, store),
          Effect.andThen(store.get(session.id)),
          Effect.map((current) => current ?? session),
        )
      }))
      return { ...original, create }
    })),
  )) as typeof layer) }
}
