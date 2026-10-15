import path from "node:path"
import { OPENCODE_CHANNEL } from "./version"

export function databasePath(data: string) {
  // Sanitise first, then decide. A channel that sanitises to nothing must never reach the
  // suffix branch -- that is what produced the orphaned `opencode-.db`.
  const channel = OPENCODE_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/^[-.]+|-+$/g, "")
  const filename =
    process.env.OPENCODE_DB ??
    (!channel ||
    ["latest", "dev", "beta", "next", "prod", "local"].includes(channel) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
      ? "opencode.db"
      : `opencode-${channel}.db`)
  return filename === ":memory:" ? filename : path.resolve(data, filename)
}
