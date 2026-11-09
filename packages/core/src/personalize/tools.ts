import { Context, Effect, Scope } from "effect"
import { Plugin } from "../plugin/personalize"

export function decorate(stock: typeof import("../plugin/internal")) {
  type Requirements = Exclude<ReturnType<typeof Plugin.effect> extends Effect.Effect<unknown, unknown, infer R> ? R : never, Scope.Scope>
  const list: typeof stock.list = Effect.fn("PluginInternal.list")(function* (...args: Parameters<typeof stock.list>) {
    const plugins = yield* stock.list(...args)
    const context = Context.omit(Scope.Scope)(yield* Effect.context<Requirements>())
    return {
      ...plugins,
      post: [...plugins.post, {
        id: Plugin.id,
        revision: "internal",
        source: { type: "builtin" as const },
        effect: (host) => Plugin.effect(host).pipe(Effect.provide(context)),
      }],
    }
  })
  return { list }
}
