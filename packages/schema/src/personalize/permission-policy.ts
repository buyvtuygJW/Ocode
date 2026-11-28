import { parsePermissionShorthand, type FilesystemDecision } from "../permission-shorthand.js"
import { executableInvocations, singleExecutableScope } from "./single-executable.js"
import { zipEntryRead } from "./zip-entry-read.js"

/** Owned protocol data travels through stock Request.metadata, not new SDK fields. */
export const metadataKey = "opencode.permission.v1"
export type Operation = FilesystemDecision["operation"]
export type Facts = {
  readonly operations: readonly Operation[]
  readonly paths: readonly string[]
  readonly directories?: readonly string[]
  readonly access?: "content" | "listing"
  /** Absent means the server's local environment, never all machines. */
  readonly machine?: string
}
export type RequestLike = {
  readonly action: string
  readonly message?: string
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly resources: readonly string[]
  readonly save?: readonly string[]
  readonly operations?: readonly Operation[]
  readonly paths?: readonly string[]
  readonly directories?: readonly string[]
  readonly access?: "content" | "listing"
}

const operations = new Set(["read", "create", "update", "delete"])
const strings = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)

export function validateFacts(value: unknown): Facts {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid filesystem permission facts")
  const facts = value as Record<string, unknown>
  if (!strings(facts.operations) || facts.operations.length === 0 ||
    facts.operations.some((operation) => !operations.has(operation)) ||
    new Set(facts.operations).size !== facts.operations.length ||
    !strings(facts.paths) || facts.paths.length === 0 ||
    (facts.directories !== undefined && (!strings(facts.directories) || facts.directories.length === 0)) ||
    (facts.access !== undefined && facts.access !== "content" && facts.access !== "listing") ||
    (facts.machine !== undefined && (typeof facts.machine !== "string" || !facts.machine || /[\0\r\n]/.test(facts.machine))))
    throw new Error("Invalid filesystem permission facts")
  return {
    operations: [...facts.operations] as Operation[],
    paths: [...facts.paths],
    ...(facts.directories === undefined ? {} : { directories: [...facts.directories as readonly string[]] }),
    ...(facts.access === undefined ? {} : { access: facts.access as Facts["access"] }),
    ...(facts.machine === undefined ? {} : { machine: facts.machine as string }),
  }
}

/** No path or CRUD operation is inferred from a tool name, save glob, or search text. */
export function readFacts(request: Pick<RequestLike, "metadata" | "operations" | "paths" | "directories" | "access">): Facts | undefined {
  const hasOwned = request.metadata !== undefined && Object.hasOwn(request.metadata, metadataKey)
  // Older external-directory callers can provide paths without classifying an
  // operation (for example a shell). That is not a CRUD entitlement.
  const hasLegacy = request.operations !== undefined
  const owned = hasOwned ? validateFacts(request.metadata![metadataKey]) : undefined
  const legacy = hasLegacy ? validateFacts(request) : undefined
  // During migration, mixed old/new callers must agree; neither representation
  // may silently widen or override the other.
  if (owned && legacy && JSON.stringify(owned) !== JSON.stringify(legacy))
    throw new Error("Conflicting filesystem permission facts")
  return owned ?? legacy
}

export function withFacts<T extends { readonly metadata?: Readonly<Record<string, unknown>> }>(
  request: T,
  facts: Facts,
): T & { readonly metadata: Readonly<Record<string, unknown>> } {
  const value = validateFacts(facts)
  const existing = request.metadata?.[metadataKey]
  if (request.metadata && Object.hasOwn(request.metadata, metadataKey) &&
    JSON.stringify(validateFacts(existing)) !== JSON.stringify(value))
    throw new Error("Conflicting filesystem permission facts")
  return { ...request, metadata: { ...request.metadata, [metadataKey]: value } }
}

export function unknownShell(request: Pick<RequestLike, "action" | "message" | "metadata">): boolean {
  if (request.action !== "shell") return false
  return request.metadata?.filesystemEffects === "unknown" || request.message?.startsWith("Unknown effects:") === true
}

/** Recompute from the full command; never trust an executable-name metadata hint. */
export function unknownInvocations(request: Pick<RequestLike, "action" | "metadata">) {
  const metadata = request.metadata
  if (request.action !== "shell" || metadata?.filesystemEffects !== "unknown" ||
    typeof metadata.unknownCommand !== "string" || typeof metadata.unknownShell !== "string") return
  return executableInvocations(metadata.unknownCommand, metadata.unknownShell)
}

export function unknownExecutable(request: Pick<RequestLike, "action" | "metadata">): string | undefined {
  return unknownInvocations(request)?.[0]?.executable
}

export function unknownZipRead(request: Pick<RequestLike, "action" | "metadata">) {
  const m = request.metadata
  if (request.action !== "shell" || m?.filesystemEffects !== "unknown" ||
    typeof m.unknownCommand !== "string" || !m.unknownCommand.toLowerCase().includes("::openread(") ||
    typeof m.unknownShell !== "string" || typeof m.unknownCwd !== "string") return
  return zipEntryRead(m.unknownCommand, m.unknownShell, m.unknownCwd)
}

export function unknownExecutableScope(request: Pick<RequestLike, "action" | "metadata">) {
  const metadata = request.metadata
  if (request.action !== "shell" || metadata?.filesystemEffects !== "unknown" ||
    typeof metadata.unknownCommand !== "string" || typeof metadata.unknownShell !== "string" ||
    typeof metadata.unknownCwd !== "string") return
  return singleExecutableScope(metadata.unknownCommand, metadata.unknownShell, metadata.unknownCwd)
}

export type UnknownScope = "executable" | "executable-all" | "whole"

/** Shared by backend validation and every permission presenter. */
export function parsePolicy(text: string, unknown: boolean):
  | { readonly kind: "unknown"; readonly lifetime: "once" | "session"; readonly scope?: UnknownScope }
  | { readonly kind: "filesystem"; readonly rules: readonly FilesystemDecision[] } {
  if (unknown && /^whole=sea$/i.test(text.trim())) return { kind: "unknown", lifetime: "session", scope: "whole" }
  if (unknown && (!text.trim() || /^(?:unknown|whole)(?:\s|=|$)/i.test(text.trim()))) {
    const match = /^unknown=(1|s|se|sea)$/i.exec(text.trim())
    if (!match) throw new Error("Use Unknown=1, Unknown=S, Unknown=SE, Unknown=SEA, or Whole=SEA; no wildcard.")
    if (match[1].toLowerCase() === "se") return { kind: "unknown", lifetime: "session", scope: "executable" }
    if (match[1].toLowerCase() === "sea") return { kind: "unknown", lifetime: "session", scope: "executable-all" }
    return { kind: "unknown", lifetime: match[1].toLowerCase() === "s" ? "session" : "once" }
  }
  const parsed = parsePermissionShorthand(text)
  if (parsed.mcp !== undefined)
    throw new Error("MCP selection belongs to tool configuration, not a directory permission grant.")
  if (parsed.filesystem.length === 0) throw new Error("Select at least one filesystem operation.")
  return { kind: "filesystem", rules: parsed.filesystem }
}

export function policyError(text: string, unknown: boolean, request?: RequestLike): string | undefined {
  try {
    const parsed = parsePolicy(text, unknown)
    if (parsed.kind === "unknown" && parsed.scope && request) {
      if (parsed.scope === "whole") {
        if (!commandScopes(request).includes("Whole=SEA")) throw new Error("Whole=SEA requires the full shell command, shell and working directory.")
        return
      }
      if (parsed.scope === "executable-all" && unknownZipRead(request)) return
      if (!unknownExecutable(request)) throw new Error(executablePolicyError)
      if (parsed.scope === "executable" && !unknownExecutableScope(request)) throw new Error(executableScopeError)
    }
    if (parsed.kind === "filesystem" && unknown && request) {
      if (!unknownPolicyDirectory(request)) throw new Error("Shell CRUD settings require a displayed working directory.")
      if (parsed.rules.some((rule) => rule.lifetime === "once"))
        throw new Error("Shell CRUD settings require =S or =D; use Unknown=1 for one shell invocation.")
    }
  }
  catch (error) { return error instanceof Error ? error.message : String(error) }
}

export const executablePolicyError = "Per-executable approval requires one command with a literal name or path. Unknown=SEA also accepts && chains of that command. Use Whole=SEA for the whole script pattern."
export const executableScopeError = "Unknown=SE requires literal arguments to keep their structure and directories fixed. Use Unknown=SEA to approve this command with variable arguments."

/** Policy success is not proof that the original request was actually settled. */
export function isPolicyReply(reply: unknown): boolean {
  return (typeof reply === "object" && reply !== null) ||
    (typeof reply === "string" && [
      "session_read", "session_create", "session_update", "session_delete", "session_crud",
    ].includes(reply))
}

export type CommandScope = "Unknown=S" | "Unknown=SE" | "Unknown=SEA" | "Whole=SEA"
export type Choice = "once" | "session_read" | "policy" | "always" | "reject" | CommandScope
export const unknownPolicyTitle = "Unknown command policy"
export const exactSessionHint = "=S allows this exact command for this session."
export function isCommandScope(choice: unknown): choice is CommandScope {
  return choice === "Unknown=S" || choice === "Unknown=SE" || choice === "Unknown=SEA" || choice === "Whole=SEA"
}
function commandScopes(request: RequestLike): CommandScope[] {
  const metadata = request.metadata
  if (metadata?.filesystemEffects !== "unknown" || typeof metadata.unknownCommand !== "string" ||
    typeof metadata.unknownCwd !== "string" || typeof metadata.unknownShell !== "string") return []
  const scopes: CommandScope[] = ["Unknown=S"]
  if (unknownExecutableScope(request)) scopes.push("Unknown=SE")
  if (unknownExecutable(request) || unknownZipRead(request)) scopes.push("Unknown=SEA")
  return [...scopes, "Whole=SEA"]
}
const filesystemEditor = {
  title: "Session CRUD policy",
  initial: "",
  presets: [] as readonly string[],
  placeholder: "RU=S* CD=D*",
  apply: "Apply filesystem policy",
  hint: "RU=S* CD=D* · selected subtree + descendants · survives restart · =1 once · =S session · =D deny · * recursive · R=-S parent listing only. Omitted operations unchanged.",
} as const

export function choices(request: RequestLike): readonly Choice[] {
  if (unknownShell(request)) {
    const exact = commandScopes(request).includes("Unknown=S")
    return exact ? ["once", "policy", "Unknown=S", "reject"] : ["once", "policy", "reject"]
  }
  const facts = readFacts(request)
  const policy = facts !== undefined && (!!facts.directories?.length || request.action === "external_directory")
  return [
    "once",
    ...(policy ? ["policy" as const] : []),
    ...(policy && facts.operations.every((operation) => operation === "read") ? ["session_read" as const] : []),
    ...(request.save?.length ? ["always" as const] : []),
    "reject",
  ]
}

export function choiceLabel(choice: Choice, unknown: boolean, stock: (choice: "once" | "always" | "reject") => string): string {
  if (choice === "Unknown=S") return "=S"
  if (isCommandScope(choice)) return choice
  if (unknown) {
    if (choice === "once") return "=1"
    if (choice === "policy") return "Custom"
    if (choice === "reject") return "=Deny"
  }
  if (choice === "session_read") return "only read recursive"
  if (choice === "policy") return "Session CRUD policy…"
  return stock(choice)
}

export function policyDirectories(request: RequestLike): readonly string[] {
  // Presentation fallback only: the backend never derives a grant from save.
  const facts = readFacts(request)
  const shellDirectory = unknownPolicyDirectory(request)
  if (shellDirectory) return [shellDirectory.machine ? `${shellDirectory.machine}:${shellDirectory.directory}` : shellDirectory.directory]
  if (facts?.machine && facts.directories) return facts.directories.map((directory) => `${facts.machine}:${directory}`)
  return facts?.directories ?? request.directories ??
    request.resources.map((resource) => resource.replace(/\/\*$/, ""))
}

/** Shell CRUD edits configure a displayed directory; they do NOT approve shell execution. */
export function unknownPolicyDirectory(request: Pick<RequestLike, "action" | "metadata">) {
  const metadata = request.metadata
  if (request.action !== "shell" || metadata?.filesystemEffects !== "unknown" ||
    typeof metadata.unknownCwd !== "string" || !metadata.unknownCwd ||
    (metadata.unknownMachine !== undefined && (typeof metadata.unknownMachine !== "string" ||
      !metadata.unknownMachine || /[\0\r\n]/.test(metadata.unknownMachine)))) return
  return { directory: metadata.unknownCwd, machine: metadata.unknownMachine as string | undefined }
}

export function policyEditor(request: RequestLike) {
  if (!unknownShell(request)) return filesystemEditor
  const scopes = commandScopes(request)
  const modes = ["Unknown=1", ...scopes]
  const hints = ["Fill one; blank keeps current rules. Unknown=1: once."]
  if (scopes.includes("Unknown=S")) hints.push("Unknown=S: exact, this session.")
  const executable = unknownExecutable(request)
  if (scopes.includes("Unknown=SEA") && executable) {
    if (scopes.includes("Unknown=SE")) {
      hints.push("Unknown=SE: same argument structure.")
    }
    hints.push(`Unknown=SEA: ${executable}, any arguments.`)
  } else if (scopes.includes("Unknown=SEA")) {
    hints.push("Unknown=SEA: reuse this ZIP entry read. File permissions apply to each archive.")
  }
  if (scopes.includes("Whole=SEA")) hints.push("Whole=SEA: whole script pattern.")
  const initial = scopes.includes("Whole=SEA") ? "Unknown= Whole=" : "Unknown="
  return { title: unknownPolicyTitle, apply: "Apply command policy", initial, presets: modes, placeholder: modes.join(" / "), hint: hints.join(" ") }
}

/** Only the editor accepts blank slots. The backend still receives one validated rule. */
export function policyDraft(text: string, unknown: boolean) {
  return unknown ? text.trim().split(/\s+/).filter((word) => !/^(unknown|whole)=$/i.test(word)).join(" ") : text.trim()
}

/** Only cycle an untouched template or the last keyboard selection. */
export function createPolicyPicker() {
  let picked = ""
  return (editor: ReturnType<typeof policyEditor>, text: string, direction: -1 | 1) => {
    if (!editor.presets.length || (text && text !== editor.initial && text !== picked)) return
    const rule = policyDraft(text, true)
    const index = rule ? editor.presets.indexOf(rule) : direction === 1 ? -1 : 0
    const presets = editor.presets
    const next = presets[(index + direction + presets.length) % presets.length]!
    picked = editor.initial.replace(next.slice(0, next.indexOf("=") + 1), next)
    return picked
  }
}
