import { afterEach, test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { forwardPlugin, loadManifest, moduleShim, normalizeChannel, personalizationPlugins } from "./build.mjs"

const directories = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const temporary = path.join(tmpdir(), "opencode")
  mkdirSync(temporary, { recursive: true })
  const root = mkdtempSync(path.join(temporary, "personalize-resolver-"))
  directories.push(root)
  mkdirSync(path.join(root, ".personalize"))
  writeFileSync(path.join(root, "stock.ts"), "// deliberately unlike ANY old source\nexport const value = 1\n")
  writeFileSync(path.join(root, "owned.ts"), "export const decorate = stock => ({ value: stock.value + 1 })\n")
  writeFileSync(path.join(root, ".personalize/manifest.json"), JSON.stringify({ modules: [
    { target: "stock.ts", factory: "owned.ts", exports: ["value"] },
  ] }))
  return root
}

function registrations(plugins) {
  const registrations = { onLoad: [], onResolve: [] }
  for (const plugin of plugins) plugin.setup({
    onLoad(options, callback) { registrations.onLoad.push({ options, callback }) },
    onResolve(options, callback) { registrations.onResolve.push({ options, callback }) },
  })
  return registrations
}

test("channel normalization handles null/undefined/bad names without trim crashes", () => {
  for (const value of [undefined, null, "", "undefined", " null ", "a/b", 1]) assert.equal(normalizeChannel(value), "local")
  assert.equal(normalizeChannel(" custom "), "custom")
})

test("wrapper delegates every untouched export and contains no stock implementation", () => {
  const root = fixture()
  const shim = moduleShim(root, [...loadManifest(root).values()][0])
  assert.match(shim, /export \* from "personalize:original:/)
  assert.match(shim, /export const value = stage0.value/)
  assert(!shim.includes("value = 1"))
  assert(!shim.includes("deliberately unlike"))
})

test("unknown optional files are not invented and missing owned modules fail closed", () => {
  const root = fixture()
  assert.equal(loadManifest(root).size, 1)
  rmSync(path.join(root, "owned.ts"))
  assert.throws(() => loadManifest(root), /owned module missing/)
})

test("original module bytes stay byte-for-byte untouched", () => {
  const root = fixture()
  const hooks = registrations(personalizationPlugins([], { root }))
  const original = hooks.onLoad.find((h) => h.options.namespace === "personalize-original")
  assert.equal(original.callback({ path: path.join(root, "stock.ts") }).contents,
    readFileSync(path.join(root, "stock.ts"), "utf8"))
})

test("private originals cannot address arbitrary unregistered files", () => {
  const root = fixture()
  const hooks = registrations(personalizationPlugins([], { root }))
  const resolve = hooks.onResolve.find((h) => h.options.namespace === "file")
  assert.throws(() => resolve.callback({ path: "personalize:original:" + encodeURIComponent(path.join(root, "secret.ts")) }), /Unregistered/)
})

test("stock Solid/virtual/native callbacks receive originals in their expected file namespace", () => {
  const seen = []
  const hooks = registrations([forwardPlugin({ name: "stock-solid", setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, (args) => { seen.push(args); return { contents: "compiled-by-stock-solid", loader: "js" } })
  } })])
  const original = hooks.onLoad.find((h) => h.options.namespace === "personalize-original")
  assert.equal(original.callback({ path: "stock.tsx", namespace: "personalize-original" }).contents, "compiled-by-stock-solid")
  assert.equal(seen[0].namespace, "file")
})

test("custom upstream plugin namespaces are not duplicated or rewritten", () => {
  const hooks = registrations([forwardPlugin({ name: "stock-virtual", setup(build) {
    build.onLoad({ filter: /.*/, namespace: "opencode" }, () => ({ contents: "embedded" }))
  } })])
  assert.equal(hooks.onLoad.length, 1)
  assert.equal(hooks.onLoad[0].options.namespace, "opencode")
})

test("non-writable SDK methods can be adapted without assigning to inherited fields", () => {
  const calls = []
  const build = Object.freeze({ onLoad: (...args) => calls.push(args), onResolve() {} })
  forwardPlugin({ name: "frozen-sdk", setup(api) { api.onLoad({ filter: /x/ }, () => undefined) } }).setup(build)
  assert.equal(calls.length, 2)
  assert.equal(calls[0][0].namespace, "file")
  assert.equal(calls[1][0].namespace, "personalize-original")
})

test("plugin order intercepts the selected file, then delegates original transforms before raw fallback", () => {
  const root = fixture()
  const plugins = personalizationPlugins([{ name: "stock", setup() {} }], { root })
  assert.deepEqual(plugins.map((p) => p.name), ["personalize-owned-module-boundaries", "stock", "personalize-stock-modules-unchanged"])
})
