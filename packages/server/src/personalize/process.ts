import os from "node:os"
import path from "node:path"
import { Effect, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import { Flock } from "@opencode/util/flock"
import { PersonalizeBoot } from "@opencode/util/personalize-boot"
import { defaults, duration } from "@opencode/util/personalize-lifetime"
import { save } from "@opencode/util/personalize-lifetime-store"
import { authorizedRequest, unauthorizedResponse } from "../middleware/authorization"
import { armIdleWatchdog, lifetime } from "./idle-state"

export function decorate(stock: typeof import("../process")) {
  // Keep the complete stock signature and forward its tail unchanged.
  const start: typeof stock.start = (options, ...rest) => {
    const [lifecycle, transform] = rest
    if (lifecycle) {
      rest[0] = {
        ...lifecycle,
        onListen: (address, shutdown) => Effect.gen(function* () {
            const cleanup = yield* lifecycle.onListen(address, shutdown)
            armIdleWatchdog(() => { void Effect.runPromise(shutdown).catch(console.error) })
            // The unref'd hard deadline survives graceful finalizers. If they
            // hang it still kills; if the process exits normally it holds no
            // handles open and needs no extra cleanup machinery.
            return cleanup.pipe(Effect.ensuring(Effect.sync(() => {
              lifetime.softStopping = true
              lifetime.changed()
            })))
          }),
      }
      rest[1] = (app) => {
        const next = transform ? transform(app) : app
        return Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest
          if (new URL(request.url, "http://localhost").pathname === "/_personalize/lifetime") {
            if (!(yield* authorizedRequest(request, { password: Option.fromNullishOr(options.password), username: "opencode" })))
              return unauthorizedResponse(request)
            const reply = (body: unknown, status = 200) => HttpServerResponse.text(JSON.stringify(body), {
              status, contentType: "application/json",
            })
            if (request.method === "GET") return reply(lifetime.settings)
            if (request.method !== "PUT") return reply({ error: "Use GET or PUT" }, 405)
            const body: unknown = yield* request.json.pipe(Effect.catch(() => Effect.succeed(undefined)))
            if (!body || typeof body !== "object") return reply({ error: "Expected command and duration" }, 400)
            const command = Reflect.get(body, "command"), input = Reflect.get(body, "duration")
            if ((command !== "killtime" && command !== "softkilltime") || typeof input !== "string")
              return reply({ error: "Expected killtime or softkilltime and a duration" }, 400)
            const key = command === "killtime" ? "hardMs" : "softMs"
            let ms: number
            try { ms = duration(input, defaults[key]) }
            catch (error) { return reply({ error: error instanceof Error ? error.message : String(error) }, 400) }
            const settings = { ...lifetime.settings, [key]: ms }
            try { save(settings) }
            catch { return reply({ error: "Could not save lifetime settings; nothing changed" }, 500) }
            lifetime.configure(settings)
            return reply(settings)
          }
          // A mutation in progress protects soft shutdown; reads/heartbeats do
          // not keep an idle server alive. Job leases protect asynchronous work.
          if (request.method === "GET" || request.method === "HEAD") return yield* next
          return yield* Effect.acquireUseRelease(
            Effect.sync(() => lifetime.work("requests")),
            () => next,
            (done) => Effect.sync(done),
          )
        })
      }
    }
    return Effect.acquireUseRelease(
      Effect.promise((signal) => Flock.acquire("service-bootstrap", {
        dir: path.join(os.tmpdir(), "opencode", "personalize-boot-locks"), signal,
      }).then((lease) => {
        let done = false
        const release = () => {
          if (done) return Promise.resolve()
          done = true
          return lease.release()
        }
        return { release }
      })),
      (boot) => stock.start(options, ...rest).pipe(Effect.provideService(PersonalizeBoot, {
        retry: Effect.void, release: Effect.promise(() => boot.release()),
      })),
      (boot) => Effect.promise(() => boot.release()),
    )
  }
  return { start }
}
