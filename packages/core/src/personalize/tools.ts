import { Context, Effect, Scope } from "effect"
import { Plugin } from "../plugin/personalize"
import { ModelResolver } from "../model-resolver.js"
import { Instance } from "../instance/service.js"
import { Database } from "../database/database.js"
import { LayerNode } from "@opencode/util/effect/layer-node"

export function decorate(stock: typeof import("../plugin/internal")) {
  type Requirements = Exclude<ReturnType<typeof Plugin.effect> extends Effect.Effect<unknown, unknown, infer R> ? R : never, Scope.Scope>
  const list = Effect.fn("PluginInternal.list")(function* (...args: Parameters<typeof stock.list>) {
    const plugins = yield* stock.list(...args)
    const memberModels = yield* ModelResolver.Service
    const context = Context.omit(Scope.Scope)(yield* Effect.context<Requirements>())
    return {
      ...plugins,
      post: [...plugins.post, {
        id: Plugin.id,
        revision: "internal",
        source: { type: "builtin" as const },
        effect: (host) => Plugin.effect(host).pipe(Effect.provideService(ModelResolver.Service, memberModels), Effect.provide(context)),
      }],
    }
  })
  return { list, requirements: LayerNode.group([stock.requirements, ModelResolver.node, Instance.node, Database.node]) }
}
