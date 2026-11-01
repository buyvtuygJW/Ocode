import type { BunPlugin } from "bun"

export function normalizeChannel(value: unknown): string
export function personalizationPlugins(plugins: BunPlugin[], options?: {
  root?: string
}): BunPlugin[]
export const PersonalizeBuild: { plugins: typeof personalizationPlugins }
