/**
 * Identify one literal command target across a PowerShell invocation or && chain.
 * PATH names (git, node), script launchers and explicit paths are commands too;
 * a filename extension neither proves nor disproves that a target is runnable.
 * This is syntax classification, not binary resolution or a subprocess sandbox.
 */
export function singleExecutable(command: string, shell: string): string | undefined {
  return executableInvocations(command, shell)?.[0]?.executable
}

export function executableInvocations(command: string, shell: string, expandArguments = true) {
  const basename = shell.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase()
  if (!basename || !["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(basename)) return undefined
  // This intentionally rejects tabs as well as newlines and other controls.
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(command)) return undefined
  // PowerShell also treats smart quotes as delimiters. An ASCII-only lexer must
  // not mistake one for inert data inside a quoted argument.
  if (/[\u2018-\u201f]/u.test(command)) return undefined
  const invocations: { executable: string; arguments: string[]; command: string }[] = []
  let start = 0
  while (true) {
    const invocation = parseInvocation(command, start, expandArguments)
    if (!invocation || (invocations.length && invocations[0]!.executable !== invocation.executable)) return undefined
    invocations.push({
      executable: invocation.executable, arguments: invocation.arguments,
      command: command.slice(start, invocation.end).trim(),
    })
    if (invocation.end === command.length) return invocations
    start = invocation.end + 2 // parseInvocation stopped at an unquoted &&.
  }
}

function parseInvocation(command: string, startIndex: number, expandArguments: boolean) {
  let index = startIndex
  const chainBoundary = () => command.startsWith("&&", index)
  const tokenEnd = () => index === command.length || command[index] === " " || chainBoundary()
  const spaces = () => { while (command[index] === " ") index++ }
  spaces()
  const call = command[index] === "&"
  if (call) { index++; spaces() }

  const variable = () => {
    const match = /^\$(?:[a-z_][a-z0-9_]*(?::[a-z_][a-z0-9_]*)?|\{[a-z_][a-z0-9_]*(?::[a-z_][a-z0-9_]*)?\})/i.exec(command.slice(index))
    if (!match) return undefined
    index += match[0].length
    return match[0]
  }
  const token = (expand = false): { value: string; quoted: boolean } | undefined => {
    const first = command[index]
    if (first === "'" || first === '"') {
      index++
      let value = ""
      let closed = false
      while (index < command.length) {
        const char = command[index++]!
        if (char === first) {
          if (first === "'" && command[index] === "'") {
            value += "'"
            index++
            continue
          }
          closed = true
          break
        }
        if (first === '"' && char === "`") return undefined
        if (first === '"' && char === "$") {
          if (!expand) return undefined
          index--
          const name = variable()
          if (!name) return undefined // In particular, never allow $(command).
          value += name
          continue
        }
        value += char
      }
      if (!closed || !tokenEnd()) return undefined
      return { value, quoted: true }
    }
    const start = index
    while (!tokenEnd()) {
      if (expand && index === start && command[index] === "$") {
        if (!variable()) return undefined
        // A plain scalar/path argument, not member/index access or an expression.
        if (!tokenEnd() && !["/", "\\"].includes(command[index]!)) return undefined
        continue
      }
      // No PowerShell metacharacters, quoting, escapes, variable/splat
      // expansion, or wildcard syntax are permitted in a bare token.
      if (!/^[\p{L}\p{N}_.:,/\\=+\-]$/u.test(command[index]!)) return undefined
      index++
    }
    if (index === start) return undefined
    return { value: command.slice(start, index), quoted: false }
  }

  const executable = token()
  if (!executable || (executable.quoted && !call)) return undefined
  const normalized = executable.value.replaceAll("/", "\\")
  const absolute = /^[a-z]:\\/i.test(normalized)
  const relative = normalized.startsWith(".\\")
  const named = /^[\p{L}\p{N}_][\p{L}\p{N}_.-]*$/u.test(normalized)
  if (!absolute && !relative && !named) return undefined
  if (named && /^(?:begin|break|catch|class|continue|data|define|do|dynamicparam|else|elseif|end|enum|exit|filter|finally|for|foreach|from|function|if|in|inlinescript|parallel|param|process|return|sequence|switch|throw|trap|try|until|using|var|while|workflow)$/i.test(normalized)) return undefined
  const segments = (absolute ? normalized.slice(3) : relative ? normalized.slice(2) : normalized).split("\\")
  if (!segments.length || segments.some((segment) =>
    !segment || segment === "." || segment === ".." || /[. ]$/.test(segment) ||
    /[\u0000-\u001f\u007f-\u009f<>:"|?*\[\]{}()$`@#;&~]/u.test(segment) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) return undefined

  const args: string[] = []
  while (index < command.length && !chainBoundary()) {
    if (command[index] !== " ") return undefined
    spaces()
    if (index === command.length || chainBoundary()) break
    const argument = token(expandArguments)
    if (!argument) return undefined
    args.push(argument.value)
  }
  // Only drive letters are unconditionally case-insensitive. Windows can enable
  // case-sensitive directories; different executable spellings must not alias.
  // Do not merge PATH names with paths, or git with git.exe: resolution may
  // differ. The policy key also binds cwd, shell, machine and lookup environment.
  return { executable: absolute ? normalized[0]!.toLowerCase() + normalized.slice(1) : normalized, arguments: args, end: index }
}

// Only unambiguous Windows path components are eligible for directory scoping.
// This is lexical classification, not a filesystem or subprocess sandbox.
function pathParts(value: string): { absolute: boolean; parts: string[] } | undefined {
  const path = value.replaceAll("/", "\\")
  const absolute = /^[a-z]:\\/i.test(path)
  if (!absolute && (path.startsWith("\\") || /^[a-z]:/i.test(path))) return undefined
  const rest = absolute ? path.slice(3) : path
  const parts = rest ? rest.split("\\") : []
  if (parts.some((part) =>
    !part || part === "." || part === ".." || /[. ]$/.test(part) ||
    /[\u0000-\u001f\u007f-\u009f<>:"|?*\[\]{}()$`@#;&~=+]/u.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return undefined
  return { absolute, parts: absolute ? [path[0]!.toLowerCase() + ":", ...parts] : parts }
}

function pathParent(value: string, cwd?: string): string | undefined {
  // Bare words are command names or ordinary values, not file operands.
  if (!/[\\/]/.test(value) && !/^[^\\/]+\.[^\\/]+$/.test(value)) return undefined
  if (!/[\\/]/.test(value) && /\s/u.test(value)) return undefined
  const path = pathParts(value)
  if (!path || !path.parts.length || (path.absolute && path.parts.length < 2)) return undefined
  // An extensionless operand may name a directory/test root. Do not turn
  // D:/work/test into an approval for D:/work/src merely because both have
  // D:/work as their parent. Explicit/ambiguous directory operands stay exact.
  if (!/^[^.].*\.[^.\s]+$/u.test(path.parts.at(-1)!)) return undefined
  if (path.absolute) return path.parts.slice(0, -1).join("\\")
  if (!cwd) return undefined
  const base = pathParts(cwd.replace(/[\\/]+$/u, (suffix) => /^[a-z]:$/i.test(cwd.slice(0, -suffix.length)) ? "\\" : ""))
  if (!base?.absolute) return undefined
  return [...base.parts, ...path.parts.slice(0, -1)].join("\\")
}

/**
 * Classify the parsed argv conservatively. Path-like operands can vary only in
 * basename within the same lexical parent; all other arguments remain exact.
 */
export function singleExecutableScope(
  command: string,
  shell: string,
  cwd?: string,
): { executable: string; arguments: readonly string[]; modeKey: string } | undefined {
  // SE promises fixed argument structure/parents. An unresolved variable cannot
  // establish either; SEA explicitly opts into arbitrary executable arguments.
  const invocations = executableInvocations(command, shell, false)
  if (invocations?.length !== 1) return undefined
  const parsed = invocations[0]!
  const shape: string[][] = []
  for (const argument of parsed.arguments) {
    const option = /^(--?[a-zA-Z][a-zA-Z0-9-]*=)(.*)$/u.exec(argument)
    // Other options, including unfamiliar equals forms, must remain exact.
    if (argument.startsWith("-") && !option) {
      shape.push(["literal", argument])
      continue
    }
    const value = option ? option[2]! : argument
    const parent = pathParent(value, cwd)
    const entry = parent === undefined ? ["literal", argument] : ["path", option?.[1] ?? "", parent]
    const previous = shape.at(-1)
    // A positional file list can grow or shrink within the same parent. Never
    // collapse repeated options or move operands across a command/option boundary.
    if (entry[0] === "path" && entry[1] === "" &&
      previous?.[0] === "path" && previous[1] === "" && previous[2] === entry[2]) continue
    shape.push(entry)
  }
  return { executable: parsed.executable, arguments: parsed.arguments, modeKey: JSON.stringify(shape) }
}
