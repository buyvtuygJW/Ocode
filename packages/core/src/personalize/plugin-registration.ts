import type { Plugin } from "@opencode/plugin/effect/plugin"
import type { Effect } from "effect"
import type { PluginInternal } from "../plugin/internal"

type Registry = Effect.Success<ReturnType<typeof PluginInternal.list>>

/** Register through the builtin list, without decorating a builtin's module or implementation. */
export function registerAfter(registry: Registry, anchor: string, plugin: Plugin): Registry {
  const matches = registry.pre.flatMap((entry, index) => entry.id === anchor ? [index] : [])
  if (matches.length !== 1) throw new Error(`Expected one builtin registration for ${anchor}; found ${matches.length}`)
  if ([...registry.pre, ...registry.post].some((entry) => entry.id === plugin.id))
    throw new Error(`Duplicate builtin registration: ${plugin.id}`)
  const entry = { id: plugin.id, effect: plugin.effect, revision: "internal", source: { type: "builtin" as const } }
  return { ...registry, pre: [...registry.pre.slice(0, matches[0] + 1), entry, ...registry.pre.slice(matches[0] + 1)] }
}
