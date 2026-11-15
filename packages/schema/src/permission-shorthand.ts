/** Local filesystem intent. Path resolution and durable/one-shot grants belong to the caller. */
export interface FilesystemDecision {
  readonly operation: "read" | "create" | "update" | "delete"
  readonly effect: "allow" | "deny" | "ask"
  readonly lifetime: "once" | "session"
  readonly recursive: boolean
  readonly scope: "selected" | "parent-list"
}

/** Plain JSON, shared by config, core and browser UI; omitted decisions remain omitted. */
export interface PermissionShorthand {
  readonly filesystem: readonly FilesystemDecision[]
  readonly mcp?: readonly string[]
}

/** Selection can change disabled, but retains the rest of the server's config. */
export type CompiledMcpSetting<T> = {
  [Key in keyof T]: Key extends "disabled" ? boolean | undefined : T[Key]
} & { readonly disabled?: boolean }

export class PermissionShorthandError extends Error {
  readonly token: string

  constructor(message: string, token: string) {
    super(`${message}: ${token}`)
    this.name = "PermissionShorthandError"
    this.token = token
  }
}

const operations = {
  R: "read",
  C: "create",
  U: "update",
  D: "delete",
} as const

/**
 * Parse everything before returning anything. No settings or grants are mutated.
 * =1 is one request; =S is a durable conversation-family decision; =D is a
 * session denial. Negative R scope permits parent listing, never parent file reads.
 */
export function parsePermissionShorthand(text: string): PermissionShorthand {
  const filesystem: FilesystemDecision[] = []
  const seen = new Set<FilesystemDecision["operation"]>()
  let mcp: string[] | undefined
  for (const token of text.trim().split(/\s+/u).filter(Boolean)) {
    if (/^ALL:/iu.test(token))
      throw new PermissionShorthandError("All-resource enforcement is unsupported", token)
    if (/^MCP:=/iu.test(token)) {
      if (mcp !== undefined) throw new PermissionShorthandError("Duplicate MCP selection", token)
      const names = token.slice(5).split(",")
      if (names.some((name) => name === "" || /[*:=]/u.test(name)))
        throw new PermissionShorthandError("Expected exact configured MCP server names separated by commas", token)
      if (new Set(names).size !== names.length)
        throw new PermissionShorthandError("Duplicate MCP server name", token)
      mcp = names
      continue
    }
    const match = /^([RCUD]+)=(-?[1SD])(\*)?$/iu.exec(token)
    if (!match) throw new PermissionShorthandError("Unknown permission shorthand token", token)
    const letters = match[1].toUpperCase()
    const value = match[2].toUpperCase()
    const parent = value.startsWith("-")
    const recursive = match[3] !== undefined
    if (parent && (letters !== "R" || value === "-D" || recursive))
      throw new PermissionShorthandError("Negative scope requires R=-1 or R=-S without recursion", token)
    for (const letter of letters) {
      const operation =
        letter === "R" ? operations.R : letter === "C" ? operations.C : letter === "U" ? operations.U : operations.D
      if (seen.has(operation))
        throw new PermissionShorthandError(`Duplicate or contradictory ${operation} decision`, token)
      seen.add(operation)
      filesystem.push({
        operation,
        effect: value === "D" ? "deny" : "allow",
        lifetime: value === "1" || value === "-1" ? "once" : "session",
        recursive,
        scope: parent ? "parent-list" : "selected",
      })
    }
  }
  return { filesystem, ...(mcp === undefined ? {} : { mcp }) }
}

/** Canonical text. There is no approved spelling for ask; never invent one. */
export function formatPermissionShorthand(value: PermissionShorthand): string {
  const groups = new Map<string, string>()
  for (const decision of value.filesystem) {
    const entry = Object.entries(operations).find(([, operation]) => operation === decision.operation)
    if (
      entry === undefined ||
      decision.effect === "ask" ||
      (decision.effect === "deny" && decision.lifetime !== "session") ||
      (decision.scope === "parent-list" && (decision.operation !== "read" || decision.effect !== "allow" || decision.recursive))
    )
      throw new PermissionShorthandError("Decision has no approved shorthand spelling", JSON.stringify(decision))
    const suffix =
      `${decision.scope === "parent-list" ? "-" : ""}` +
      `${decision.effect === "deny" ? "D" : decision.lifetime === "once" ? "1" : "S"}` +
      `${decision.recursive ? "*" : ""}`
    groups.set(suffix, (groups.get(suffix) ?? "") + entry[0])
  }
  const text = [
    ...Array.from(groups, ([suffix, letters]) => `${letters}=${suffix}`),
    ...(value.mcp === undefined ? [] : [`MCP:=${value.mcp.join(",")}`]),
  ].join(" ")
  parsePermissionShorthand(text)
  return text
}

/**
 * Compile only the MCP availability axis into existing per-server disabled
 * settings: selected configured servers are enabled, other configured servers
 * are disabled. Tool-specific permission rules are not modified. This says
 * nothing about a server's external side effects or separately attached clients.
 */
export function compileMcpSelection<T extends { readonly disabled?: boolean }>(
  selection: readonly string[] | undefined,
  servers: Readonly<Record<string, T>>,
): Record<string, CompiledMcpSetting<T>> {
  if (selection !== undefined) {
    for (const name of selection)
      if (!Object.hasOwn(servers, name))
        throw new PermissionShorthandError("Unknown configured MCP server", name)
  }
  const selected = selection === undefined ? undefined : new Set(selection)
  // The spread preserves each union variant; only disabled is widened. TS cannot
  // infer that distributive relationship through Object.fromEntries.
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [
      name,
      selected === undefined ? { ...server } : { ...server, disabled: !selected.has(name) },
    ]),
  ) as Record<string, CompiledMcpSetting<T>>
}

/** Validate both axes before callers apply any settings or scoped grant. */
export function compilePermissionShorthand<T extends { readonly disabled?: boolean }>(
  text: string,
  servers: Readonly<Record<string, T>>,
) {
  const decisions = parsePermissionShorthand(text)
  const mcpSettings = compileMcpSelection(decisions.mcp, servers)
  return { decisions, mcpSettings }
}
