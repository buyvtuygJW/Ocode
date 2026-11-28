import assert from "node:assert/strict"
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { test } from "node:test"

test("native Node loads emitted-specifier TS dependencies without stubbing their code", () => {
  const parent = path.join(tmpdir(), "opencode")
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(path.join(parent, "node-ts-source-"))
  try {
    mkdirSync(path.join(root, ".personalize"))
    mkdirSync(path.join(root, "packages/source"), { recursive: true })
    cpSync(new URL("./node-typescript.mjs", import.meta.url), path.join(root, ".personalize/node-typescript.mjs"))
    writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n')
    writeFileSync(path.join(root, "packages/source/value.ts"), "export const value: number = 42\n")
    writeFileSync(path.join(root, "packages/source/read.ts"), 'export { value } from "./value.js"\n')
    const run = (file) => spawnSync(process.execPath, ["--experimental-transform-types",
      "--import", "./.personalize/node-typescript.mjs", "--input-type=module", "-e",
      `import {value} from ${JSON.stringify(file)}; if (value !== 42) throw new Error("wrong module");`,
    ], { cwd: root, encoding: "utf8" })
    const source = run("./packages/source/read.ts")
    assert.equal(source.status, 0, source.stderr)
    writeFileSync(path.join(root, "packages/source/value.js"), "export const value = 7\n")
    const javascript = run("./packages/source/read.ts")
    assert.notEqual(javascript.status, 0)
    assert.match(javascript.stderr, /wrong module/, "existing JS must take precedence over adjacent TS")
    writeFileSync(path.join(root, "packages/source/missing.ts"), 'export { value } from "./absent.js"\n')
    assert.match(run("./packages/source/missing.ts").stderr, /ERR_MODULE_NOT_FOUND/)
    writeFileSync(path.join(root, "outside.ts"), "export const value = 42\n")
    writeFileSync(path.join(root, "packages/source/outside.ts"), 'export { value } from "../../outside.js"\n')
    assert.match(run("./packages/source/outside.ts").stderr, /ERR_MODULE_NOT_FOUND/,
      "the preload must not redirect imports outside source packages")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
