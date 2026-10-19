export * as ConfigMarkdown from "./markdown.js"

import matter from "gray-matter"
export function parse(content: string) {
  // Passing options bypasses gray-matter's module-global content cache, which
  // it populates before parsing: a failed YAML parse poisons the entry and
  // every later parse of the same content replays it without throwing, so the
  // sanitize fallback below never runs. Upstream: jonschlinkert/gray-matter#166.
  try {
    return matter(content, {})
  } catch {
    return matter(sanitize(content), {})
  }
}

export function parseOption(content: string) {
  try {
    return parse(content)
  } catch {
    return undefined
  }
}

// Other coding agents (e.g. Claude Code) accept loose YAML in SKILL.md / agent
// frontmatter that strict YAML rejects: unquoted colons in values, hyphenated
// keys (allowed-tools), values wrapped across unindented lines, tab indentation,
// and a leading BOM. On a parse failure we normalize the frontmatter into
// equivalent valid YAML -- a plain-scalar value that needs escaping (contains a
// colon or spills onto following lines) becomes a literal `|-` block scalar --
// and retry. The rewrite is validated before it is returned: if it still does
// not parse, the original content is returned unchanged, the strict parse
// error propagates, and callers skip the file. This runs ONLY after the
// strict parse has already failed, so valid files are never touched.
export function sanitize(content: string) {
  const stripped = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content
  const match = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return content
  const frontmatter = match[1]

  // top-level "key:" or "key: value" (hyphen/dot keys allowed; space after ":" optional)
  const KEY = /^([A-Za-z0-9][\w.-]*)[ \t]*:(?:[ \t]*(.*))?$/
  // an intentional block-scalar header ("|", ">", "|-", ">2", ...) — leave alone
  const BLOCK_HEADER = /^[|>][+-]?\d*$/
  const isComment = (line: string) => /^\s*#/.test(line)

  // tabs are illegal as YAML indentation -> spaces
  const detab = (line: string) => {
    const m = line.match(/^[ \t]+/)
    return m ? m[0].replace(/\t/g, "  ") + line.slice(m[0].length) : line
  }

  const lines = frontmatter.split(/\r?\n/).map(detab)

  const groups: { key: string; value: string; children: string[] }[] = []
  const preface: string[] = []
  let current: { key: string; value: string; children: string[] } | null = null
  for (const line of lines) {
    const entry = /^[ \t]/.test(line) || isComment(line) ? null : line.match(KEY)
    if (entry) {
      current = { key: entry[1], value: (entry[2] ?? "").trim(), children: [] }
      groups.push(current)
    } else if (current) {
      current.children.push(line)
    } else {
      preface.push(line)
    }
  }

  const needsBlock = (v: string) => v.includes(":") || / #/.test(v)

  const out: string[] = [...preface]
  for (const g of groups) {
    // content lines that belong to this key's value (drop blanks and comments)
    const body = g.children.filter((c) => c.trim() !== "" && !isComment(c))
    const structured = g.children.some((c) => /^[ \t]+\S/.test(c) || /^\s*- /.test(c))
    const quoted = g.value.startsWith('"') || g.value.startsWith("'")

    // keep verbatim: a real block/list (empty value + indented block), an
    // explicit block-scalar header, or a clean single-line quoted value
    if ((g.value === "" && structured) || BLOCK_HEADER.test(g.value) || (quoted && body.length === 0)) {
      out.push(g.value ? `${g.key}: ${g.value}` : `${g.key}:`)
      for (const c of g.children) out.push(c)
      continue
    }

    // empty value followed only by loose unindented text -> fold it in
    if (g.value === "") {
      if (body.length === 0) {
        out.push(`${g.key}:`)
        for (const c of g.children) out.push(c)
      } else {
        out.push(`${g.key}: |-`)
        for (const c of body) out.push(`  ${c.trim()}`)
      }
      continue
    }

    // inline value: block-scalar it if it wraps onto more lines or needs escaping
    if (body.length > 0 || needsBlock(g.value)) {
      out.push(`${g.key}: |-`)
      out.push(`  ${g.value}`)
      for (const c of body) out.push(`  ${c.trim()}`)
    } else {
      out.push(`${g.key}: ${g.value}`)
    }
  }

  const result = stripped.replace(frontmatter, () => out.join("\n"))
  // the rewrite must parse -- otherwise return the input untouched so the
  // strict parse error propagates and callers skip the file
  try {
    matter(result, {})
  } catch {
    return content
  }
  return result
}
