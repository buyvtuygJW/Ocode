import { Context, Effect, Layer } from "effect"
import type { makeLocationNode } from "@opencode/util/effect/app-node"
import type { Permission } from "../permission.js"
import type { Bus } from "../bus.js"
import type { Location } from "../location.js"
import type { Agent } from "../agent.js"
import type { SessionStore } from "../session/store.js"
import type { PermissionSaved } from "../permission/saved.js"
import type { PluginHooks } from "../plugin/hooks.js"
import { Database } from "../database/database.js"

type Services = Bus.Service | Location.Service | Agent.Service | SessionStore.Service |
  PermissionSaved.Service | PluginHooks.Service
type Binding = {
  db: Database.Interface["db"]
  connect?: (original: Permission.Interface) => Effect.Effect<Permission.Interface, never, import("effect").Scope.Scope>
}

// Each layer construction gets its own binding. A missing factory is an error,
// never an unpersonalized permission service or a process-wide singleton.
export const PermissionBinding = Context.Reference<Binding | undefined>("Personalize.PermissionBinding", {
  defaultValue: () => undefined,
})

/** Permission-specific extension of the ordinary location-node factory. */
export function permissionNode(stockNode: typeof makeLocationNode, input: {
  service: typeof Permission.Service
  layer: Layer.Layer<Permission.Service, never, Services>
  deps: readonly [
    typeof Bus.node, typeof Location.node, typeof Agent.node,
    typeof SessionStore.node, typeof PermissionSaved.node, typeof PluginHooks.node,
  ]
}) {
  const layer = Layer.unwrap(Effect.gen(function* () {
    const { db } = yield* Database.Service
    const binding: Binding = { db }
    return input.layer.pipe(
      Layer.provide(Layer.succeed(PermissionBinding, binding)),
      Layer.flatMap((context) => Layer.effect(input.service, Effect.suspend(() => {
        if (!binding.connect) return Effect.die(new Error("Permission runtime was not connected"))
        return binding.connect(Context.get(context, input.service))
      }))),
    )
  }))
  // Projection belongs to the global application graph, not each location.
  // Adding it here registers duplicate projectors on an externally supplied Bus
  // and can leave that Bus pointing at a location's already-closed database.
  return stockNode({ ...input, layer, deps: [...input.deps, Database.node] })
}
