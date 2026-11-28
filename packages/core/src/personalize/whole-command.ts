import { scan, scanPowerShell } from "../shell/scan.js"

// Build the key from the *entire* source, removing only argv that the shell
// scanner identified as data. In particular, a list of command names alone
// would lose conditionals, assignments, pipes, redirections and nested code.
export function wholeCommandPattern(source: string, shell: string) {
  const name = shell.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase().replace(/\.exe$/, "")
  const powershell = name === "powershell" || name === "pwsh"
  const parsed = powershell ? scanPowerShell(source)
    : name === "bash" || name === "zsh" ? scan(source, name)
    : name === "sh" || name === "dash" || name === "ksh" ? scan(source, "posix") : undefined
  if (parsed?.kind !== "scanned") return { pattern: ["verbatim", source], commands: [] }

  const commands = parsed.commands.map((item) => item.resource)
  const counts = new Map<string, number>()
  for (const resource of commands) counts.set(resource, (counts.get(resource) ?? 0) + 1)
  const seen = new Set<string>()
  const ranges: [number, number][] = []
  // Offsets provided by the scanner are relative to each resource. If the
  // same text also occurs in data or a comment, leave that resource untouched.
  let budget = 8 * 1024 * 1024
  for (const cmd of parsed.commands) {
    const { resource, rawWords } = cmd
    if (seen.has(resource) || !resource || rawWords.length < 2 || cmd.declaration) continue
    seen.add(resource)
    if ((budget -= source.length) < 0) break
    const starts: number[] = []
    for (let index = source.indexOf(resource); index !== -1; index = source.indexOf(resource, index + resource.length)) {
      starts.push(index)
      if (starts.length > counts.get(resource)!) break
    }
    if (starts.length !== counts.get(resource)) continue
    // For shells without wordEnds, only the ordinary contiguous argv form is
    // eligible. Assignment prefixes and redirect operands must stay in the key.
    let end = cmd.wordEnds?.[0] ?? rawWords[0]!.length
    if (!resource.slice(0, end).endsWith(rawWords[0]!) ||
      (!cmd.wordEnds && (!resource.startsWith(rawWords[0]!) || cmd.redirectPrefixEnd !== undefined))) continue
    for (const [index, raw] of rawWords.slice(1).entries()) {
      let start = end
      while (resource[start] === " " || resource[start] === "\t") start++
      if (start === end || !resource.startsWith(raw, start)) break
      const previous = end
      end = start + raw.length
      if (cmd.wordEnds && cmd.wordEnds[index + 1] !== end) break
      // Raw syntax, not cooked word values: expansions or script blocks must
      // never disappear along with argv. Preserve the stop-parsing operator.
      const data = /^[\p{L}\p{N}_./:=+\\-]+$/u.test(raw) ||
        (powershell ? /^'(?:[^'\r\n]|'')*'$/.test(raw) : /^'[^'\r\n]*'$/.test(raw)) ||
        (powershell ? /^"(?:[^"`$\r\n]|\$(?:[\w:]+|\{[\w:]+\}))*"$/.test(raw) : /^"[^"$`\\\r\n]*"$/.test(raw)) ||
        (powershell && /^\$[\w:]+(?:\.\w+)*$/.test(raw))
      if (data) for (const at of starts) ranges.push([at + previous, at + end])
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  let end = 0
  const kept: string[] = []
  for (const [start, next] of ranges) {
    if (start < end) continue
    kept.push(source.slice(end, start))
    end = next
  }
  kept.push(source.slice(end))
  return { pattern: ["script", kept.join(""), ...parsed.commands.map((item) => item.rawWords[0] ?? "")], commands }
}
