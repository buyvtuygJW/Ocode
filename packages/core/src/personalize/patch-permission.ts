import { Effect } from "effect"
import type { FileDiff } from "@opencode/schema/file-diff"
import type { Operation } from "@opencode/schema/personalize/permission-contract"
import type { Patch } from "@opencode/util/patch"
import { FileAccess } from "../file-access.js"
import { Permission } from "../permission.js"
import { filesystemMetadata, optionalStat } from "./filesystem-permission.js"

/** Per-invocation authorization ledger; patch parsing, previews and writes stay stock. */
export function makePatchPermissions(deps: {
  access: Pick<FileAccess.Interface, "resolve" | "authorizeExternal">
  permission: Pick<Permission.Interface, "assert">
  context: FileAccess.Invocation
  updates: ReadonlyMap<string, { target: FileAccess.Target; content: string | null }>
}) {
  const needs: { target: FileAccess.Target; operation: Operation }[] = []
  const authorizeTarget = Effect.fnUntraced(function* (target: FileAccess.Target, operation?: Operation) {
    const key = FileAccess.key(target)
    const exists = deps.updates.has(key) ? deps.updates.get(key)!.content !== null
      : !!(yield* optionalStat(target.environment.files, target.absolute))
    const actual = operation ?? (exists ? "update" : "create")
    needs.push({ target, operation: actual })
    if (target.externalDirectory) {
      yield* deps.access.authorizeExternal([target], deps.context, filesystemMetadata([target], [actual], undefined, {
        filepath: target.absolute,
        parentDir: target.externalDirectory.directory,
      }))
    }
    return target
  })
  const prepare = Effect.fnUntraced(function* (hunk: Patch.Hunk) {
    const target = yield* deps.access.resolve({ path: hunk.path, kind: "file" })
    const move = hunk.type === "update" && hunk.movePath
      ? yield* deps.access.resolve({ path: hunk.movePath, kind: "file" }) : undefined
    const moves = move && FileAccess.key(move) !== FileAccess.key(target)
    yield* authorizeTarget(target, hunk.type === "delete" ? "delete"
      : hunk.type === "update" ? (moves ? "delete" : "update") : undefined)
    // Stock still resolves a syntactically present move. A move back to the
    // same normalized path is an update, not a delete/create pair.
    const resolveTarget = (_value: string) => moves ? authorizeTarget(move) : Effect.succeed(target)
    return { target, resolveTarget }
  })
  const assert = Effect.fnUntraced(function* (targets: readonly FileAccess.Target[], files: readonly FileDiff.Info[]) {
    for (const need of needs) yield* deps.permission.assert({
      action: "edit", resources: [need.target.resource], save: [FileAccess.always(need.target)],
      metadata: filesystemMetadata([need.target], [need.operation], undefined, {
        filepath: targets.map((target) => target.resource).join(", "),
        diff: files.map((file) => `${file.patch}\n`).join(""),
        files,
      }),
      ...Permission.invocation(deps.context),
    })
  })
  return { prepare, assert }
}
