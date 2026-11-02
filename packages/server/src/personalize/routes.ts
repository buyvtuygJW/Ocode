import { Context, Effect, Layer, Option } from "effect"
import { Job } from "@opencode/core/job"
import { Bus } from "@opencode/core/bus"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionEvent } from "@opencode/schema/session-event"
import { lifetime } from "./idle-state"

// One route-builder seam, using the app's actual services (not a second bus).
export function decorate(stock: typeof import("../routes")) {
  const createRoutes: typeof stock.createRoutes = (options, urls, ...rest) => {
    const jobs = Job.node.mapLayer((layer) => layer.pipe(Layer.flatMap((context) => {
      const service = Context.get(context, Job.Service)
      const start: Job.Interface["start"] = (input) => Effect.suspend(() => {
        const done = lifetime.work()
        let handedOff = false
        return service.start({ ...input, run: input.run.pipe(Effect.ensuring(Effect.sync(done))) }).pipe(
          Effect.tap(() => Effect.sync(() => { handedOff = true })),
          Effect.ensuring(Effect.sync(() => { if (!handedOff) done() })),
        )
      })
      return Layer.succeed(Job.Service, { ...service, start })
    })))
    const executions = SessionExecution.node.mapLayer((layer) => layer.pipe(Layer.flatMap((context) =>
      Layer.effect(SessionExecution.Service, Effect.gen(function* () {
        const service = Context.get(context, SessionExecution.Service)
        // This dependency already belongs to the stock execution graph. Query
        // it without changing mapLayer's dependency contract.
        const bus = yield* Effect.serviceOption(Bus.Service)
        if (Option.isNone(bus)) {
          lifetime.softBlocked = true
          return service // Hard control remains available if soft cannot prove safety.
        }
        const running = new Map<string, () => void>()
        lifetime.externalBusy = () => Effect.runSync(service.active).size > 0
        const unsubscribe = yield* bus.value.listen((event) => Effect.sync(() => {
          if (!event.data || typeof event.data !== "object") return
          const id = Reflect.get(event.data, "sessionID")
          if (typeof id !== "string") return
          if (event.type === SessionEvent.Execution.Started.type && !running.has(id))
            running.set(id, lifetime.work())
          if (event.type === SessionEvent.Execution.Succeeded.type || event.type === SessionEvent.Execution.Failed.type ||
            event.type === SessionEvent.Execution.Interrupted.type) {
            running.get(id)?.()
            running.delete(id)
          }
        }))
        yield* Effect.addFinalizer(() => unsubscribe.pipe(Effect.andThen(Effect.sync(() => {
          for (const done of running.values()) done()
          lifetime.externalBusy = () => false
        }))))
        return service
      })),
    )))
    // Caller replacements retain priority. Forward every stock argument.
    rest[0] = [Job.node.replace(jobs), SessionExecution.node.replace(executions), ...(rest[0] ?? [])]
    return stock.createRoutes(options, urls, ...rest)
  }
  return { createRoutes }
}
