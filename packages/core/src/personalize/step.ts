import { LLMClient } from "@opencode/ai/effect"
import { Context, Effect, Stream } from "effect"
import { StepFailedError } from "../session/error"
import { OutputGate } from "./output-policy"

export function decorate(stock: typeof import("../session/runner/step")) {
  const make: typeof stock.make = Effect.gen(function* () {
    const context = yield* Effect.context<Effect.Services<typeof stock.make>>()
    const client = Context.get(context, LLMClient.Service)
    const attempt: Effect.Success<typeof stock.make>["attempt"] = (input) => Effect.gen(function* () {
      // State belongs to this attempt, never to a shared session/global client.
      let rejected: OutputGate["rejected"]
      const stream: typeof client.stream = (...args) => Stream.suspend(() => {
        const gate = new OutputGate()
        return client.stream(...args).pipe(
          Stream.flatMap((event) => Stream.fromArray(gate.push(event))),
          Stream.concat(Stream.suspend(() => {
            const events = gate.end()
            rejected = gate.rejected
            return Stream.fromArray(events)
          })),
        )
      })
      const service = yield* stock.make.pipe(Effect.provide(Context.add(context, LLMClient.Service, { ...client, stream })))
      const outcome = yield* service.attempt(input)
      if (rejected || outcome._tag === "OutputLimit") return yield* new StepFailedError({
        error: {
          type: rejected === "invalid" ? "invalid-response" : "output-limit",
          message: rejected === "invalid"
            ? "Invalid model response: local tool calls were withheld. No automatic retry."
            : "Model response was truncated or incomplete: local tool calls were withheld. No automatic continuation; request a smaller output or explicitly change effort.",
        },
      })
      return outcome
    })
    return { attempt }
  })
  return { make }
}
