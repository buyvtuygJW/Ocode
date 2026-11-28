import path from "node:path"
import { Cause, Effect, Exit, Layer, Scope } from "effect"
import { Global } from "@opencode/util/global"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { sqliteBusy, updateBoot, withBootLock } from "@opencode/util/personalize-boot"
import { storageDiagnostic } from "@opencode/util/personalize-storage-diagnostic"
import { guardSessionSchema } from "./schema-guard"

export function decorate(stock: typeof import("../database/database")) {
  const layer: typeof stock.layer = (options = { path: ":memory:" }) => {
    const filename = options.path ?? ":memory:"
    if (filename === ":memory:") return stock.layer(options)
    return Layer.effectContext(Effect.gen(function* () {
      const global = yield* Global.Service
      const file = path.isAbsolute(filename) ? filename : path.join(global.data, filename)
      const parent = yield* Scope.Scope
      return yield* withBootLock(
        "database-bootstrap:" + (process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file)),
        () => Effect.gen(function* () {
          for (let attempt = 0; ; attempt++) {
            const scope = yield* Scope.make()
            yield* Scope.addFinalizerExit(parent, (exit) => Scope.close(scope, exit))
            const exit = yield* Effect.exit(Layer.buildWithScope(stock.layer({ ...options, path: file }), scope))
            if (Exit.isSuccess(exit)) {
              // Schema drift guard: runs after migrations settle; never throws (see schema-guard.ts).
              guardSessionSchema(file)
              return exit.value
            }
            yield* Scope.close(scope, exit)
            if (attempt >= 6 || !sqliteBusy(Cause.pretty(exit.cause))) {
              yield* Effect.logError("database bootstrap failed", {
                databasePath: file, attempt: attempt + 1, ...storageDiagnostic(exit.cause),
              })
              return yield* Effect.failCause(exit.cause)
            }
            yield* updateBoot("retry")
            yield* Effect.sleep((attempt + 1) * 200)
          }
        }),
        // All openers of this database share state even when their TEMP differs.
        { directory: path.join(global.state, "personalize-boot-locks-v2") },
      )
    }))
  }
  const configured: typeof stock.configured = (options) =>
    makeGlobalNode({ service: stock.Service, layer: layer(options), deps: [Global.node] })
  return { layer, configured, node: configured({ path: ":memory:" }) }
}
