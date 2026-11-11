// PERSONALIZATION (deltav11) — prompt-cache miss trace.
// Observes step-finish only, after the stock publisher has handled it; never
// alters events. Logs a warning when a step reads zero cached tokens after an
// idle gap > 10 min, splitting the expected (>= 1h, cache expired) case from
// the one worth optimizing (10 min .. 1h, retention should have held).
import { Effect } from "effect"
import { SessionUsage } from "../session/usage"

const lastStepFinish = new Map<string, number>()

export function decorate(stock: typeof import("../session/runner/publish-llm-event")) {
  const createLLMEventPublisher: typeof stock.createLLMEventPublisher = (bus, input) => {
    const publisher = stock.createLLMEventPublisher(bus, input)
    const trace = (usage: Parameters<typeof SessionUsage.tokens>[0]) =>
      Effect.suspend(() => {
        const gap = input.started - (lastStepFinish.get(input.sessionID) ?? Infinity)
        lastStepFinish.set(input.sessionID, Date.now())
        const { input: uncached, cache } = SessionUsage.tokens(usage)
        if (cache.read !== 0 || uncached <= 1024 || gap <= 10 * 60_000) return Effect.void
        return Effect.logWarning(
          gap >= 60 * 60_000
            ? "cache-miss: idle >= 1h, prompt cache expired as expected (1h max cache)"
            : "cache-miss: idle > 10min but < 1h still missed -- harness cache retention can be optimized",
          { sessionID: input.sessionID, idleMinutes: Math.round(gap / 60_000), uncachedInput: uncached },
        )
      })
    return {
      ...publisher,
      publish: (event) =>
        event.type === "step-finish"
          ? publisher.publish(event).pipe(Effect.tap(() => trace(event.usage)))
          : publisher.publish(event),
    }
  }
  return { createLLMEventPublisher }
}
