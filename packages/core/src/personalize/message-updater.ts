// PERSONALIZATION (deltav11) — guard 2: prose echo.
// Strips runs of adjacent duplicate sentences from ONE assistant text part
// before the message is projected and stored, so both the display and the
// next request's context carry the deduped text. The first occurrence is
// kept; each stripped run leaves one inline marker. Cross-part and
// cross-turn repetition is deliberately untouched (it may be deliberate).
import { bumpLedger, dedupeText, punchLine } from "./dedup"

export function decorate(stock: typeof import("../session/message-updater")) {
  const update: typeof stock.update = (adapter, event) => {
    if (event.type === "session.text.ended") {
      const data = event.data as { readonly text: string; readonly sessionID?: unknown; readonly assistantMessageID?: unknown }
      const result = dedupeText(data.text)
      if (result) {
        const key = String(data.sessionID ?? data.assistantMessageID ?? "session")
        const entry = bumpLedger(key, "prose", result.wastedTokens)
        const punch = punchLine(entry)
        const text = punch ? `${result.text}\n${punch}` : result.text
        event = { ...event, data: { ...data, text } }
      }
    }
    return stock.update(adapter, event)
  }
  return { update }
}
