export * as Status from "./service-status"

import { Effect, Ref } from "effect"

export type State =
  | { readonly type: "starting" }
  | { readonly type: "ready" }
  | { readonly type: "stopping" }
  | { readonly type: "failed"; readonly reason?: string }

export interface Interface {
  readonly current: Effect.Effect<State>
  readonly ready: Effect.Effect<void>
  readonly fail: (reason?: string) => Effect.Effect<void>
  readonly beginStopping: Effect.Effect<void>
}

export const make = Effect.fnUntraced(function* (options: { readonly initial?: State } = {}) {
  const current = yield* Ref.make(options.initial ?? ({ type: "starting" } satisfies State))
  const beginStopping = Ref.update(current, (status) =>
    status.type === "stopping" ? status : ({ type: "stopping" } satisfies State),
  )

  return {
    current: Ref.get(current),
    ready: Ref.update(current, (status) => (status.type === "starting" ? ({ type: "ready" } satisfies State) : status)),
    fail: (reason?: string) =>
      Ref.update(current, (status) =>
        status.type === "starting"
          ? ((reason === undefined ? { type: "failed" } : { type: "failed", reason }) satisfies State)
          : status,
      ),
    beginStopping,
  } satisfies Interface
})
