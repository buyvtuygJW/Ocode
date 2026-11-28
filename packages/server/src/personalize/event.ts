import { Event } from "@opencode/schema/event"
import { Effect, Stream } from "effect"
import { HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { EventFeed } from "../event-feed"
import { lifetime } from "./idle-state"

// ============================================================================
// PERSONALIZATION (deltav11) — SSE handler with idle-reaper activity.
// Actual stream ownership, not a 15s heartbeat estimate: even /killtime 1s
// must leave connected windows alone. A scoped lease is released when the
// stream closes, fails, or is interrupted. The stock module is referenced
// only in the type position below — erased at build, no runtime cycle.
// ============================================================================

export function decorate(stock: typeof import("../handlers/event")) {
  const EventHandler = HttpApiBuilder.group(Api, "server.event", (handlers) =>
    Effect.gen(function* () {
      const feed = yield* EventFeed.Service
      return handlers.handleRaw("event.subscribe", (ctx) =>
        Effect.gen(function* () {
          const connected = {
            id: Event.ID.create(),
            type: "server.connected",
            data: {},
          } as const
          const output = Stream.unwrap(
            Effect.acquireRelease(Effect.sync(() => lifetime.connect()), (close) => Effect.sync(close)).pipe(
              Effect.andThen(feed.subscribe(ctx.query.types)),
              Effect.map((live) => Stream.make(EventFeed.frame(connected)).pipe(Stream.concat(live))),
            ),
          )
          const heartbeat = Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n"))
          return HttpServerResponse.stream(
            output.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }), Stream.encodeText),
            {
              contentType: "text/event-stream",
              headers: {
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
                "X-Content-Type-Options": "nosniff",
              },
            },
          )
        }),
      )
    }),
  ) as typeof stock.EventHandler

  return { EventHandler }
}
