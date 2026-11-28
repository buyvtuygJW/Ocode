import path from "node:path"
import { createHash } from "node:crypto"
import { Effect } from "effect"
import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
import { FileAccess } from "../file-access.js"
import { Permission } from "../permission.js"
import { unknownZipRead } from "@opencode/schema/personalize/permission-policy"
import { filesystemMetadata } from "./filesystem-permission.js"

// Only simple built-in queries and literal output in system Windows PowerShell
// without profiles are known not to touch the filesystem. Parsing alone is not
// proof: redirects, pipes, substitutions and scripts must remain unknown.
export function hasNoFilesystemEffects(
  command: string,
  shell: string,
  platform: string = process.platform,
  systemRoot = process.env.SystemRoot,
): boolean {
  if (platform !== "win32" || !systemRoot || !path.win32.isAbsolute(systemRoot)) return false
  const expected = path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  if (path.win32.normalize(shell).toLowerCase() !== expected.toLowerCase()) return false
  if (/[\r\n]/.test(command)) return false
  const output = /^[ \t]*(?:Write-Output|Write-Host|echo)(?:[ \t]+(?:[A-Za-z0-9_.:,!?/-]+|'[A-Za-z0-9 ._,:!?/-]*'|"[A-Za-z0-9 ._,:!?/-]*"))+[ \t]*$/i
  const date = /^[ \t]*Get-Date(?:[ \t]+-Format[ \t]+(?:[A-Za-z0-9_.:/-]+|'[A-Za-z0-9 ._,:/-]+'|"[A-Za-z0-9 ._,:/-]+"))?[ \t]*$/i
  const query = /^[ \t]*(?:Get-Location|pwd|Get-Host|Get-Culture|Get-UICulture|Get-Random)[ \t]*$/i
  return output.test(command) || date.test(command) || query.test(command)
}

/** Stock resolves the final target and scans denies; add unknown-effect policy
 * to its requests without replacing machine routing or pre-spawn validation. */
export const authorizeShellRequests = Effect.fnUntraced(function* (deps: {
  readonly invocation: ShellCreateBefore
  readonly target: FileAccess.Target
  readonly context: FileAccess.Invocation
  readonly permission: Pick<Permission.Interface, "assert" | "assertNotDenied">
  readonly access: Pick<FileAccess.Interface, "resolve" | "authorizeExternal">
  readonly requests: readonly Pick<Permission.AssertInput, "action" | "resources" | "save" | "metadata">[]
}) {
  const { invocation, target, context } = deps
  const unknown = target.machine !== undefined || !hasNoFilesystemEffects(invocation.command, invocation.shell)
  yield* deps.permission.assertNotDenied({
    action: "shell", resources: [invocation.command], ...Permission.invocation(context),
  })
  const requests = unknown && !deps.requests.some((request) => request.action === "shell")
    ? [...deps.requests, { action: "shell", resources: [invocation.command] }] : deps.requests
  for (const request of requests) yield* deps.permission.assert({
    ...request,
    ...Permission.invocation(context),
    metadata: request.action === "shell" && unknown ? {
      ...request.metadata, filesystemEffects: "unknown",
      unknownCommand: invocation.command, unknownCwd: target.absolute, unknownShell: invocation.shell,
      // PATH/other environment changes must not silently reuse a named-command
      // grant. Hash the final shell environment; never publish its secret values.
      unknownLookup: createHash("sha256").update(JSON.stringify(
        Object.entries(invocation.env).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
      )).digest("hex"),
      ...(target.machine === undefined ? {} : { unknownMachine: target.machine }),
    } : request.metadata,
  })
  // A reusable shell recipe grants the operation, not its data. Resolve the
  // actual literal on the invocation's machine and check it before every spawn,
  // including when shell approval was saved or the path changed while queued.
  const zip = unknownZipRead({ action: "shell", metadata: {
    filesystemEffects: "unknown", unknownCommand: invocation.command, unknownShell: invocation.shell, unknownCwd: target.absolute,
  } })
  if (zip) {
    const file = yield* deps.access.resolve({ path: zip.archive, kind: "file", base: target })
    const metadata = filesystemMetadata([file], ["read"], "content")
    yield* deps.access.authorizeExternal([file], context, metadata)
    yield* deps.permission.assert({
      action: "read", resources: [file.resource], save: [FileAccess.always(file)], metadata,
      ...Permission.invocation(context),
    })
  }
})
