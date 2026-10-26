import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

// CI guard checker: every array-style access of `.content` in patch-owned files must sit behind an
// Array.isArray guard. Upstream has shipped messages whose `content` is undefined/non-array mid-stream;
// an unguarded `.content.map(...)` there is exactly the TypeError that broke context-decay. Scope is the
// patch-owned files only - upstream files are taken as-is and are not rewritten by this check.
const OWNED = [
  "src/config/markdown.ts",
  "src/database/database.ts",
  "src/database/v1-migration.bun.ts",
  "src/plugin/skill.ts",
  "src/session/model-request.ts",
  "src/session/runner/context-decay.ts",
  "src/session/runner/to-llm-message.ts",
  "src/session/title.ts",
]

const ACCESS =
  /\.content(\?\.|\.)(map|flatMap|filter|some|every|find|findLast|findIndex|forEach|reduce|reduceRight|slice|concat|join|at|indexOf|lastIndexOf|includes|entries|keys|values|length)\b|\.content\[/
const GUARD = /Array\.isArray\(/
const LOOKBACK = 12

describe("content guards", () => {
  test("every .content array access in patch-owned files is guarded", () => {
    const root = path.join(import.meta.dir, "..", "..")
    const errors: string[] = []
    for (const rel of OWNED) {
      const lines = readFileSync(path.join(root, rel), "utf8").split("\n")
      lines.forEach((line, index) => {
        if (!ACCESS.test(line)) return
        const from = Math.max(0, index - LOOKBACK)
        if (lines.slice(from, index + 1).some((near) => GUARD.test(near))) return
        errors.push(
          `${rel}:${index + 1} unguarded .content access -> add: const items = Array.isArray(x.content) ? x.content : [] and use items`,
        )
      })
    }
    if (errors.length) throw new Error(`unguarded .content array access:\n${errors.join("\n")}`)
    expect(errors).toEqual([])
  })
})
