import { normalizeChannel } from "../../../../.personalize/channel.mjs"

export function decorate(stock: typeof import("../version")) {
  const OPENCODE_CHANNEL = normalizeChannel(stock.OPENCODE_CHANNEL)
  return { OPENCODE_CHANNEL, OPENCODE_LOCAL: OPENCODE_CHANNEL === "local" }
}
