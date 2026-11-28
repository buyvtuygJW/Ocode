import { existsSync } from "node:fs"
import * as nodeModule from "node:module"
import { fileURLToPath } from "node:url"

const packages = new URL("../packages/", import.meta.url).href

// Source packages use emitted .js specifiers. Node's native TS runner does not
// perform the .js -> .ts resolution that TypeScript and Bun use for those sources.
// Prefer actual JavaScript and never redirect imports outside this checkout.
// Bun already resolves emitted .js specifiers to TypeScript. Do not import a
// Node-only named export when its ordinary suite discovers these shared tests.
if (!process.versions.bun) nodeModule.registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context)
    } catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".") ||
        !specifier.endsWith(".js") || !context.parentURL?.startsWith(packages)) throw error
      const source = new URL(specifier, context.parentURL)
      if (!source.href.startsWith(packages)) throw error
      source.pathname = source.pathname.slice(0, -3) + ".ts"
      if (!existsSync(fileURLToPath(source))) throw error
      return { url: source.href, shortCircuit: true }
    }
  },
})
