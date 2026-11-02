import { Context, Effect, Scope } from "effect"
import { Plugin } from "../plugin/personalize"

export function decorate(stock: typeof import("../plugin/internal")) {
  type Requirements = ReturnType<typeof Plugin.effect> extends Effect.Effect<unknown, unknown, infer R> ? R : never
  const list: typeof stock.list = Effect.fn("PluginInternal.list")(function* () {
    const plugins = yield* stock.list()
    const context = Context.omit(Scope.Scope)(yield* Effect.context<Requirements>())
    return {
      ...plugins,
      post: [...plugins.post, {
        id: Plugin.id,
        effect: (host) => Plugin.effect(host).pipe(Effect.provide(context)),
      }],
    }
  })
  return { list }
}
