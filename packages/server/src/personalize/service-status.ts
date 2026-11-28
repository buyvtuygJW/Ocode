import { Effect, Option, Ref } from "effect"
import { PersonalizeBoot } from "@opencode/util/personalize-boot"
import { lifetime } from "./idle-state"

export function decorate(stock: typeof import("../service-status")) {
  const make: typeof stock.make = (options = {}) => Effect.gen(function* () {
    type State = import("../service-status").State | { readonly type: "retrying" }
    const state = yield* Ref.make<State>(options.initial ?? { type: "starting" })
    const boot = yield* Effect.serviceOption(PersonalizeBoot)
    const release = Option.isSome(boot) ? boot.value.release : Effect.void
    if (Option.isSome(boot)) boot.value.retry = Ref.update(state, (value) =>
      value.type === "starting" || value.type === "retrying" ? { type: "retrying" } as const : value)
    return {
      // The wire may expose retrying; the owned Promise client normalizes it to waiting.
      current: Ref.get(state) as Effect.Effect<import("../service-status").State>,
      ready: Ref.update(state, (value) => value.type === "starting" || value.type === "retrying" ? { type: "ready" } as const : value)
        .pipe(Effect.andThen(release), Effect.tap(() => Effect.sync(() => lifetime.start()))),
      fail: Ref.update(state, (value) => value.type === "starting" || value.type === "retrying" ? { type: "failed" } as const : value)
        .pipe(Effect.andThen(release)),
      beginStopping: Ref.update(state, (value) => value.type === "stopping" ? value : { type: "stopping" } as const),
    }
  })
  return { make }
}
