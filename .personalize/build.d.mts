import type { BunPlugin } from "bun"

export function normalizeChannel(value: unknown): string
export function personalizationPlugins(plugins: BunPlugin[], options?: {
  root?: string
}): BunPlugin[]
export function build(options: Parameters<typeof Bun.build>[0], personalization?: {
  root?: string
}): ReturnType<typeof Bun.build>
export const PersonalizeBuild: {
  plugins: typeof personalizationPlugins
  build: typeof build
}
