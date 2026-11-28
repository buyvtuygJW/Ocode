import path from "node:path"
import { Context, Effect, Layer, Option } from "effect"
import { systemError } from "effect/PlatformError"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Git } from "../git"
import { Repository } from "../repository"
import { AbsolutePath } from "../schema"

class Removal extends Context.Service<Removal, {
  path: string
  reference: Repository.RemoteReference
}>()("@personalize/CacheRemoval") {}

export function repositoryHome(fallback: string, override = process.env.OPENCODE_REPOS_HOME) {
  if (override === undefined) return fallback
  if (!path.isAbsolute(override)) throw new Error("OPENCODE_REPOS_HOME must be an absolute directory")
  return path.resolve(override)
}

export function decorate(stock: typeof import("../repository-cache")) {
  const node = stock.node.mapLayer((layer) => Layer.unwrap(Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const global = yield* Global.Service
    const repos = repositoryHome(global.repos)
    const reject = (target: string, description: string, cause?: unknown) => systemError({
      _tag: "Unknown", module: "FileSystem", method: "remove",
      pathOrDescriptor: target, description: `Cache preserved: ${description}`, cause,
    })
    const remove: FSUtil.Interface["remove"] = (target, options) => Effect.gen(function* () {
      const expected = yield* Effect.serviceOption(Removal)
      if (Option.isNone(expected) || path.resolve(target) !== path.resolve(expected.value.path))
        return yield* Effect.fail(reject(target, "missing cache-removal scope"))
      // This runs INSIDE the stock cache flock, immediately before deletion.
      // Use strict directory reads: access errors must never mean "no .git".
      const names = yield* fs.readDirectory(target)
      if (names.includes(".git")) {
        const existing = yield* git.repo.discover(AbsolutePath.make(target))
        if (!existing) return yield* Effect.fail(reject(target,
          "Git could not inspect this existing checkout. Check Git trust and filesystem permissions; it is not stale."))
        const worktree = yield* fs.resolve(target)
        if (existing.worktree !== worktree)
          return yield* Effect.fail(reject(target, "Git discovered a different worktree"))
        const origin = yield* git.remote.get(existing).pipe(
          Effect.mapError((cause) => reject(target, "Git could not read the checkout's origin", cause)),
        )
        const parsed = origin ? Repository.parse(origin) : undefined
        if (parsed && Repository.same(parsed, expected.value.reference))
          return yield* Effect.fail(reject(target, "checkout matches the requested origin; earlier inspection failed"))
      }
      // Confirmed wrong-origin checkouts and non-Git stale directories keep the
      // stock replacement behavior. Never add broad Git trust exceptions.
      return yield* fs.remove(target, options)
    })
    return layer.pipe(
      Layer.provide([
        Layer.succeed(FSUtil.Service, { ...fs, remove }),
        Layer.succeed(Global.Service, { ...global, repos }),
      ]),
      Layer.flatMap((context) => {
        const cache = Context.get(context, stock.Service)
        return Layer.succeed(stock.Service, stock.Service.of({
          ...cache,
          ensure: (input) => cache.ensure(input).pipe(Effect.provideService(Removal, {
            path: Repository.cachePath(repos, input.reference, input.branch),
            reference: Repository.parse(input.reference.remote) ?? input.reference,
          })),
        }))
      }),
    )
  })) as typeof layer)
  return { node }
}
