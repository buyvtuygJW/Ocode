import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { normalizeChannel } from "./channel.mjs"
export { normalizeChannel } from "./channel.mjs"

const ORIGINAL = "personalize-original"
const PREFIX = "personalize:original:"
// Bun dedupes modules by path while ignoring the namespace, so the original must never
// collide with the shim's real file path. The marker sits in the basename, keeping the
// real directory so Bun's default resolver (extensions, index files, tsconfig) resolves
// the stock module's imports exactly like upstream.
const VIRTUAL = ".personalize-original~"
const directory = path.dirname(fileURLToPath(import.meta.url))

// This module is the FIRST build-script import, before Script computes its constants.
if (process.env.OPENCODE_CHANNEL !== undefined) {
  process.env.OPENCODE_CHANNEL = normalizeChannel(process.env.OPENCODE_CHANNEL)
}

const key = (value) => {
  const normalized = path.resolve(value).replaceAll("\\", "/")
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

export function loadManifest(root) {
  const result = new Map()
  for (const name of ["manifest.json", "R.json", "S.json", "X.json"]) {
    const filename = path.join(root, ".personalize", name)
    if (!existsSync(filename)) continue
    const manifest = JSON.parse(readFileSync(filename, "utf8"))
    for (const item of manifest.modules) {
      const target = path.resolve(root, item.target)
      if (!existsSync(target)) throw new Error(`Personalize target missing: ${item.target}`)
      for (const filename of [...(item.before || []), ...(item.factory ? [item.factory] : [])]) {
        if (!existsSync(path.resolve(root, filename))) throw new Error(`Personalize owned module missing: ${filename}`)
      }
      const current = result.get(key(target)) || { target, modules: [] }
      current.modules.push(item)
      result.set(key(target), current)
    }
  }
  return result
}

export function moduleShim(root, entry) {
  const original = PREFIX + encodeURIComponent(entry.target)
  const code = []
  for (const item of entry.modules) for (const filename of item.before || []) {
    code.push(`import ${JSON.stringify(path.resolve(root, filename).replaceAll("\\", "/"))}`)
  }
  code.push(`export * from ${JSON.stringify(original)}`)
  const factories = entry.modules.filter((item) => item.factory)
  if (!factories.length) return code.join("\n") + "\n"
  code.push(`import * as original from ${JSON.stringify(original)}`)
  const names = new Set()
  factories.forEach((item, index) => {
    for (const name of item.exports) {
      if (!/^[A-Za-z_$][\w$]*$/.test(name) || name === "default") throw new Error(`Invalid Personalize export: ${name}`)
      names.add(name)
    }
    code.push(`import { decorate as decorate${index} } from ${JSON.stringify(path.resolve(root, item.factory).replaceAll("\\", "/"))}`)
    for (const name of item.exports) code.push(`if (!(${JSON.stringify(name)} in original)) throw new Error(${JSON.stringify(`Personalize public export changed: ${entry.target}#${name}`)})`)
    code.push(`const stage${index} = { ...${index ? `stage${index - 1}` : "original"}, ...decorate${index}(${index ? `stage${index - 1}` : "original"}) }`)
  })
  for (const name of names) code.push(`export const ${name} = stage${factories.length - 1}.${name}`)
  return code.join("\n") + "\n"
}

/** Adapt normal plugin registrations so original TSX still uses the STOCK Solid compiler. */
export function forwardPlugin(plugin) {
  return {
    ...plugin,
    setup(build) {
      const facade = Object.create(build)
      for (const method of ["onLoad", "onResolve"]) Object.defineProperty(facade, method, {
        value(options, callback) {
          build[method]({ namespace: "file", ...options }, callback)
          if (!options.namespace || options.namespace === "file") {
            build[method]({ ...options, namespace: ORIGINAL }, (args) => callback({ ...args, namespace: "file", path: args.path.replaceAll(VIRTUAL, ""), importer: args.importer?.replaceAll(VIRTUAL, "") }))
          }
        },
      })
      return plugin.setup(facade)
    },
  }
}

export function personalizationPlugins(plugins, options = {}) {
  const root = options.root || path.resolve(directory, "..")
  const manifest = loadManifest(root)
  const aliases = {
    name: "personalize-owned-module-boundaries",
    setup(build) {
      const original = (args) => {
        const filename = decodeURIComponent(args.path.slice(PREFIX.length))
        if (!manifest.has(key(filename))) throw new Error(`Unregistered Personalize original: ${filename}`)
        const normalized = filename.replaceAll("\\", "/")
        const slash = normalized.lastIndexOf("/")
        return { path: normalized.slice(0, slash + 1) + VIRTUAL + normalized.slice(slash + 1), namespace: ORIGINAL }
      }
      build.onResolve({ filter: /^personalize:original:/, namespace: "file" }, original)
      build.onResolve({ filter: /^personalize:original:/, namespace: ORIGINAL }, original)
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/, namespace: "file" }, (args) => {
        const entry = manifest.get(key(args.path))
        if (!entry) return
        return { loader: "js", contents: moduleShim(root, entry) }
      })
    },
  }
  const originals = {
    name: "personalize-stock-modules-unchanged",
    setup(build) {
      build.onLoad({ filter: /.*/, namespace: ORIGINAL }, (args) => {
        const filename = args.path.replaceAll("\\", "/").replaceAll(VIRTUAL, "")
        return {
          // No substitutions, AST edits, copied framework implementations, or source anchors.
          contents: readFileSync(filename, "utf8"),
          loader: args.path.endsWith(".tsx") ? "tsx" : args.path.endsWith(".jsx") ? "jsx" : "ts",
        }
      })
    },
  }
  return [aliases, ...plugins.map(forwardPlugin), originals]
}

export const PersonalizeBuild = { plugins: personalizationPlugins }
