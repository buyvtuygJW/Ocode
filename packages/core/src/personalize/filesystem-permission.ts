import path from "node:path"
import { Effect } from "effect"
import type { FileDiff } from "@opencode/schema/file-diff"
import { metadataKey, readFacts, withFacts, type Facts, type Operation } from "@opencode/schema/personalize/permission-policy"
import { Environment } from "../environment/index.js"
import type { Environments } from "../environment/environments.js"
import { FileAccess } from "../file-access.js"
import { Permission } from "../permission.js"

type Files = Environment.Interface["files"]
type Metadata = Permission.AssertInput["metadata"]

/** One stat policy for reads and writes: missing is distinct from inaccessible. */
export const optionalStat = (files: Files, file: string) => files.stat(file).pipe(
  Effect.catchTag("Environment.NotFound", () => Effect.undefined),
)

export function filesystemMetadata(
  targets: readonly FileAccess.Target[],
  operations: readonly Operation[],
  access?: Facts["access"],
  metadata?: Metadata,
): Metadata {
  const machine = targets[0]?.machine
  if (targets.some((target) => target.machine !== machine))
    throw new Error("Filesystem permission facts cannot combine different machines")
  return withFacts({ metadata }, {
    operations,
    ...(machine === undefined ? {} : { machine }),
    paths: targets.map((target) => target.absolute),
    directories: [...new Set(targets.map((target) => access === "listing" || metadata?.filesystemReadScope === "recursive"
      ? target.absolute : target.externalDirectory?.directory ?? (target.environment.path ?? path).dirname(target.absolute)))],
    ...(access === undefined ? {} : { access }),
  }).metadata
}

/** External approval uses only the exact external subset, never a saved parent glob. */
export function externalMetadata(allTargets: readonly FileAccess.Target[], metadata: Metadata): Metadata {
  const targets = allTargets.filter((target) => target.externalDirectory !== undefined)
  const facts = readFacts({ metadata })
  if (!facts) return metadata
  if (!targets.every((target) => facts.paths.includes(target.absolute)))
    throw new Error("External permission facts do not describe the requested targets")
  const { [metadataKey]: _previous, ...rest } = metadata!
  return withFacts({ metadata: rest }, {
    ...facts,
    paths: targets.map((target) => target.absolute),
    directories: [...new Set(targets.map((target) => target.externalDirectory!.directory))],
  }).metadata
}

/** Add facts to stock authorization; never resolve paths or recreate its requests. */
export function filesystemReadMetadata(
  target: FileAccess.Target, environments: Pick<Environments.Interface, "ready">,
) {
  return Effect.gen(function* () {
  // The upstream resolver deliberately avoids waking a cold sandbox before approval.
  // An unknown target is conservatively content, never eligible for listing-only grants.
  const ready = yield* environments.ready(target.environment.id)
  const stat = ready ? yield* optionalStat(target.environment.files, target.absolute) : undefined
  return filesystemMetadata([target], ["read"], stat?.type === "directory" ? "listing" : "content")
  })
}

export function makeFileWritePermissions(deps: {
  readonly access: Pick<FileAccess.Interface, "resolve" | "authorizeExternal">
  readonly permission: Pick<Permission.Interface, "assert">
}) {
  const externalApproved = new WeakMap<FileAccess.Target, Operation>()
  const operation = (target: FileAccess.Target) => optionalStat(target.environment.files, target.absolute).pipe(
    Effect.map((stat): Operation => stat ? "update" : "create"),
  )
  const target = Effect.fn("FileWrite.target")(function* (file: string, context: FileAccess.Invocation) {
    const target = yield* deps.access.resolve({ path: file, kind: "file" })
    const kind = yield* operation(target)
    yield* deps.access.authorizeExternal([target], context, filesystemMetadata([target], [kind]))
    externalApproved.set(target, kind)
    return target
  })
  const authorize = Effect.fn("FileWrite.authorize")(function* (
    target: FileAccess.Target, context: FileAccess.Invocation, preview?: FileDiff.Info,
  ) {
    const kind = yield* operation(target)
    const metadata = filesystemMetadata([target], [kind], undefined, preview ? { files: [preview] } : undefined)
    // authorize() retains stock's contract: its caller obtained external access.
    // Only target() owns a recorded CRUD-specific external approval to refresh
    // if create changed to update (or vice versa) while that prompt was pending.
    // Machine transfers authorize both endpoints themselves before calling here.
    if (externalApproved.has(target) && externalApproved.get(target) !== kind) {
      yield* deps.access.authorizeExternal([target], context, metadata)
      externalApproved.set(target, kind)
    }
    yield* deps.permission.assert({
      action: "edit", resources: [target.resource], save: [FileAccess.always(target)], metadata,
      ...Permission.invocation(context),
    })
  })
  return { target, authorize }
}
