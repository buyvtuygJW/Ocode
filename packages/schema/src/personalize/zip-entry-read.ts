/** Recognize a read-only PowerShell recipe from the full script, never from
 * the shell scanner's list of method names. Unrecognized syntax has no grant. */
export function zipEntryRead(script: string, shell: string, cwd: string) {
  if (!/^(?:powershell|pwsh)(?:\.exe)?$/i.test(shell.split(/[\\/]/).pop() ?? "") ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u2018-\u201f\u2028\u2029]/u.test(script)) return

  // Remove quoted data before interpreting separators. Reject interpolation,
  // escapes and here-strings rather than approximating PowerShell evaluation.
  const literals: string[] = []
  let invalid = false
  const code = script.replace(/'(?:''|[^'\r\n])*'|"[^"$`\r\n]*"|['"@`#]/g, (token) => {
    if (token.length === 1) { invalid = true; return "" }
    const contents = token.slice(1, -1)
    literals.push(token[0] === "'" ? contents.replaceAll("''", "'") : contents)
    return `@${literals.length - 1}`
  })
  if (invalid) return

  const statements = code.split(/(?:[;\r\n]+|([{}]))/).map((part) => part?.trim()).filter((part): part is string => !!part)
  const blocks: ("try" | "finally")[] = []
  const values = new Map<string, string>()
  // Only local data variables, never scope-qualified names or PowerShell's
  // automatic/preference variables. Receivers must have been bound in this script.
  const variable = /^\$(?:z|zip|archive|e|entry|s|stream|r|reader|file|path|zippath|name|entryname|raw|text|json|data|result|first|second)$/i
  const operations: string[] = []
  let archive: string | undefined
  let entry: string | undefined
  let reads = 0

  function atom(text: string): string | undefined {
    const term = text.trim().toLowerCase()
    return /^@\d+$/.test(term) ? term : values.get(term)
  }
  function literal(text: string) {
    const value = atom(text)
    return value?.startsWith("@") ? literals[Number(value.slice(1))] : undefined
  }
  function expression(text: string, depth = 0): string | undefined {
    if (depth > 6) return
    const source = text.trim()
    const value = atom(source)
    if (value !== undefined) return value
    const open = /^\[(?:System\.)?IO\.Compression\.ZipFile\]::OpenRead\(\s*([@$]\w+)\s*\)$/i.exec(source)
    if (open && archive === undefined) {
      const file = literal(open[1]!)
      if (!file || !/\.zip$/i.test(file)) return
      const drive = /^[a-z]:[\\/]/i
      if (!(drive.test(file) && drive.test(cwd)) &&
        !(/^\/(?!\/)/.test(file) && cwd.startsWith("/") && !file.includes("\\"))) return
      // No device/stream aliases, ambiguous trailing dots/spaces or traversal.
      const components = file.replace(/^(?:[a-z]:)?[\\/]/i, "").split(/[\\/]/)
      if (components.some((part) => !part || /[. ]$|[<>:"|?*\u0000-\u001f]/u.test(part) ||
        /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) return
      archive = file
      operations.push("OpenRead")
      return "archive"
    }
    const get = /^(.+)\.GetEntry\(\s*([@$]\w+)\s*\)$/i.exec(source)
    if (get && entry === undefined && expression(get[1]!, depth + 1) === "archive") {
      entry = literal(get[2]!)
      if (!entry) return
      operations.push("GetEntry")
      return "entry"
    }
    const constructor = /^\[(?:System\.)?IO\.StreamReader\]::new\((.+)\)$/i.exec(source)
    if (constructor && expression(constructor[1]!, depth + 1) === "stream") {
      operations.push("StreamReader")
      return "reader"
    }
    const method = /^(.+)\.(Open|ReadToEnd)\(\s*\)$/i.exec(source)
    if (!method) return
    const receiver = expression(method[1]!, depth + 1)
    if (method[2]!.toLowerCase() === "open" && receiver === "entry") {
      operations.push("Open")
      return "stream"
    }
    if (method[2]!.toLowerCase() === "readtoend" && receiver === "reader") {
      operations.push("ReadToEnd")
      reads++
      return "text"
    }
  }

  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i]!
    if (/^try$/i.test(statement)) {
      if (statements[++i] !== "{") return
      blocks.push("try")
      continue
    }
    if (statement === "}") {
      const block = blocks.pop()
      if (!block) return
      if (block === "try") {
        if (statements[++i]?.toLowerCase() !== "finally" || statements[++i] !== "{") return
        blocks.push("finally")
      }
      continue
    }
    if (/^Add-Type[ \t]+-AssemblyName[ \t]+System\.IO\.Compression\.FileSystem$/i.test(statement)) {
      operations.push("Add-Type")
      continue
    }
    const dispose = /^(\$\w+)\.Dispose\(\s*\)$/i.exec(statement)
    if (dispose) {
      const receiver = atom(dispose[1]!)
      if (receiver !== "reader" && receiver !== "stream" && receiver !== "archive") return
      operations.push(`Dispose:${receiver}`)
      continue
    }
    const assignment = /^(\$\w+)\s*=\s*(.+)$/.exec(statement)
    const target = assignment?.[1]?.toLowerCase()
    if (target && (!variable.test(target) || values.has(target))) return
    const body = assignment?.[2] ?? statement
    const convert = /^(.+?)\s*\|\s*ConvertFrom-Json$/i.exec(body) ??
      /^ConvertFrom-Json\s+-InputObject\s+(.+)$/i.exec(body)
    let kind = expression(convert?.[1] ?? body)
    if (convert) {
      if (kind !== "text") return
      operations.push("ConvertFrom-Json")
      kind = "json"
    }
    if (!kind) return
    if (target) values.set(target, kind)
    else if (kind !== "text" && kind !== "json") return
  }
  if (!blocks.length && archive && entry && reads === 1)
    return { archive, entry, recipe: operations.join("/") }
}
