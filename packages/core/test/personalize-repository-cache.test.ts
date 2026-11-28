import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Context, Effect, Layer } from "effect"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { Git } from "../src/git"
import { KV } from "../src/kv"
import { Repository } from "../src/repository"
import { RepositoryCache } from "../src/repository-cache"
import { AbsolutePath } from "../src/schema"
import { decorate, repositoryHome } from "../src/personalize/repository-cache"
import { tmpdir } from "./fixture/tmpdir"

const reference = Repository.parseRemote("owner/repo")
type Mode = "unreadable" | "transient" | "origin-error" | "wrong-origin" | "missing"

function harness(root: string, mode: Mode, guarded = true) {
  let discovers = 0, clones = 0
  const git = Git.node.mapLayer((layer) => layer.pipe(Layer.flatMap((context) => {
    const original = Context.get(context, Git.Service)
    const repo = (directory: string) => new Git.Repository({
      worktree: AbsolutePath.make(directory),
      gitDirectory: AbsolutePath.make(path.join(directory, ".git")),
      commonDirectory: AbsolutePath.make(path.join(directory, ".git")),
    })
    return Layer.succeed(Git.Service, {
      ...original,
      repo: {
        ...original.repo,
        discover: (directory) => Effect.sync(() => {
          discovers++
          return mode === "unreadable" || mode === "missing" || (mode === "transient" && discovers === 1)
            ? undefined : repo(directory)
        }),
        clone: (input) => Effect.promise(async () => {
          clones++
          await fs.mkdir(path.join(input.directory, ".git"), { recursive: true })
          return repo(input.directory)
        }),
      },
      remote: { get: () => mode === "origin-error"
        ? Effect.fail(new Git.CommandError({ args: ["remote", "get-url", "origin"], exitCode: 128 }))
        : Effect.succeed(mode === "wrong-origin" ? "https://github.com/other/repo.git" : reference.remote) },
      history: { ...original.history, head: () => Effect.undefined, branch: () => Effect.undefined },
    })
  })))
  const node = guarded ? decorate(RepositoryCache).node : RepositoryCache.node
  const global = Global.make({ data: path.join(root, "data"), state: path.join(root, "state"), repos: path.join(root, "repos") })
  return {
    counts: () => ({ discovers, clones }), global,
    layer: AppNodeBuilder.build(LayerNode.group([node, Global.node]), [
      Global.node.replace(Layer.succeed(Global.Service, global)),
      Git.node.replace(git),
      KV.node.replace(Layer.succeed(KV.Service, {
        get: () => Effect.undefined, set: () => Effect.void, remove: () => Effect.void,
        scan: () => Effect.succeed({ entries: [] }),
      })),
    ]),
  }
}

async function attempt(root: string, mode: Mode, guarded = true, metadata = true) {
  const localPath = Repository.cachePath(path.join(root, "repos"), reference)
  await fs.mkdir(metadata ? path.join(localPath, ".git") : localPath, { recursive: true })
  await fs.writeFile(path.join(localPath, "keep.txt"), "existing user cache content")
  const runtime = harness(root, mode, guarded)
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const cache = yield* RepositoryCache.Service
    return yield* Effect.result(cache.ensure({ reference }))
  }).pipe(Effect.provide(runtime.layer))))
  const preserved = await fs.readFile(path.join(localPath, "keep.txt"), "utf8").then(() => true, () => false)
  return { result, preserved, ...runtime.counts() }
}

test("real stock cache deletes on empty discovery; the decorator preserves it without cloning", async () => {
  await using fixture = await tmpdir("cache-discovery-")
  const before = await attempt(path.join(fixture.path, "before"), "unreadable", false)
  expect(before.preserved).toBe(false)
  expect(before.clones).toBe(1)
  const after = await attempt(path.join(fixture.path, "after"), "unreadable")
  expect(after.preserved).toBe(true)
  expect(after.clones).toBe(0)
  expect(after.result._tag).toBe("Failure")
  if (after.result._tag === "Failure") expect(after.result.failure.message).toContain("Git could not inspect")
}, 30_000)

for (const mode of ["transient", "origin-error"] as const) {
  test(`cache preserves existing checkout after ${mode}`, async () => {
    await using fixture = await tmpdir("cache-inspection-")
    const result = await attempt(fixture.path, mode)
    expect(result.preserved).toBe(true)
    expect(result.clones).toBe(0)
    expect(result.result._tag).toBe("Failure")
  }, 30_000)
}

test("confirmed wrong-origin and non-Git stale caches retain stock replacement", async () => {
  await using fixture = await tmpdir("cache-stale-")
  for (const [mode, metadata] of [["wrong-origin", true], ["missing", false]] as const) {
    const result = await attempt(path.join(fixture.path, mode), mode, true, metadata)
    expect(result.preserved).toBe(false)
    expect(result.clones).toBe(1)
    expect(result.result._tag).toBe("Success")
  }
}, 30_000)

test("dedicated cache override changes materialization, not the global data directory", async () => {
  await using fixture = await tmpdir("cache-home-")
  const original = process.env.OPENCODE_REPOS_HOME
  const override = path.join(fixture.path, "dedicated-repos")
  process.env.OPENCODE_REPOS_HOME = override
  try {
    const runtime = harness(fixture.path, "missing")
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const cache = yield* RepositoryCache.Service
      const global = yield* Global.Service
      const result = yield* cache.ensure({ reference })
      expect(result.localPath).toBe(Repository.cachePath(override, reference))
      expect(global.data).toBe(runtime.global.data)
      expect(global.repos).toBe(runtime.global.repos)
    }).pipe(Effect.provide(runtime.layer))))
    expect(repositoryHome("fallback", override)).toBe(override)
    expect(() => repositoryHome("fallback", "relative/cache")).toThrow("absolute")
  } finally {
    if (original === undefined) delete process.env.OPENCODE_REPOS_HOME
    else process.env.OPENCODE_REPOS_HOME = original
  }
}, 30_000)
