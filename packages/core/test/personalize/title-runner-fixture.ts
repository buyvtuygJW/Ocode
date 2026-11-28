import { expect } from "bun:test"
import { Deferred, Effect, Fiber, Stream } from "effect"
import { TestLLM } from "@opencode/ai/testing"
import { Bus } from "@opencode/core/bus"
import { SessionEvent } from "@opencode/core/session/event"
import { dateTitle } from "../../src/personalize/session-naming"

type Fixture = Pick<typeof import("../session-runner.test"),
  "scenario" | "prepareTitleGeneration" | "sessionID" | "invalidRequest" | "providerRejected">

const watchPseudonym = (sessionID: Fixture["sessionID"]) => Effect.gen(function* () {
  const bus = yield* Bus.Service
  return yield* bus.subscribe(SessionEvent.Renamed).pipe(
    Stream.filter((event) => event.data.sessionID === sessionID && event.data.title.endsWith("-Brief")),
    Stream.take(1), Stream.runDrain,
    Effect.forkScoped({ startImmediately: true }),
  )
})

export const beginTitleScenario = Effect.fnUntraced(function* (
  s: import("../session-runner.test").Scenario, prepare: Fixture["prepareTitleGeneration"], sessionID: Fixture["sessionID"],
) {
  yield* prepare
  yield* s.admit("First prompt")
  yield* s.llm.push(TestLLM.text("Brief", "text-title"), Stream.never)
  return yield* watchPseudonym(sessionID)
})

// Only the two scenarios with personalized prompt, retry and title expectations.
export function titleRunnerScenarios({
  scenario, prepareTitleGeneration, sessionID, invalidRequest, providerRejected,
}: Fixture) {
  scenario("coalesces title generation while a request is active", function* (s) {
    yield* prepareTitleGeneration
    const titleStarted = yield* Deferred.make<void>()
    const releaseTitle = yield* Deferred.make<void>()
    yield* Effect.gen(function* () {
      yield* s.admit("First prompt")
      yield* s.llm.push(
        Stream.unwrap(Deferred.succeed(titleStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseTitle)),
          Effect.as(Stream.fromIterable(TestLLM.text("Brief", "text-title"))),
        )),
        TestLLM.text("First response", "text-first"),
        TestLLM.text("Second response", "text-second"),
      )
      const first = yield* s.resume.pipe(Effect.forkChild)
      yield* Deferred.await(titleStarted).pipe(Effect.timeout("5 seconds"))
      expect(s.requests[0]?.system.map((part) => part.text))
        .toContain("Summarize: one word, max 5 chars, no spaces.")
      const pending = yield* s.session.get(sessionID)
      expect(pending.title).toBe(dateTitle(pending.time.created))
      yield* Fiber.join(first)
      yield* s.admit("Second prompt")
      yield* s.resume
      expect(s.requests).toHaveLength(3)
      const renamed = yield* watchPseudonym(sessionID)
      yield* Deferred.succeed(releaseTitle, undefined)
      yield* Fiber.join(renamed)
      expect((yield* s.session.get(sessionID)).title).toBe(`${dateTitle(pending.time.created)}-Brief`)
    }).pipe(Effect.ensuring(Deferred.succeed(releaseTitle, undefined)))
  })
  scenario("retries title generation from the first prompt after title and execution failures", function* (s) {
    yield* prepareTitleGeneration
    yield* s.admit("First prompt")
    yield* s.llm.push(Stream.fail(invalidRequest()), Stream.fail(invalidRequest()))
    expect((yield* s.resume.pipe(Effect.exit))._tag).toBe("Failure")
    yield* s.admit("Second prompt")
    const titleFailed = yield* Deferred.make<void>()
    yield* s.llm.push(
      Stream.fail(providerRejected({ message: "Title provider unavailable" })).pipe(
        Stream.ensuring(Deferred.succeed(titleFailed, undefined)),
      ),
      TestLLM.text("Recovered", "text-recovered"),
    )
    yield* s.resume
    yield* Deferred.await(titleFailed)
    yield* Effect.yieldNow
    const pending = yield* s.session.get(sessionID)
    expect(pending.title).toBe(dateTitle(pending.time.created))
    const renamed = yield* watchPseudonym(sessionID)
    yield* s.admit("Third prompt")
    yield* s.llm.push(TestLLM.text("Brief", "text-title"), TestLLM.text("Recovered again", "text-recovered-again"))
    yield* s.resume
    yield* Fiber.join(renamed)
    expect(s.requests).toHaveLength(6)
    expect(JSON.stringify(s.requests[2]?.messages)).toContain("First prompt")
    expect(JSON.stringify(s.requests[2]?.messages)).not.toContain("Second prompt")
    expect(JSON.stringify(s.requests[4]?.messages)).toContain("First prompt")
    expect(JSON.stringify(s.requests[4]?.messages)).not.toContain("Third prompt")
    expect((yield* s.session.get(sessionID)).title).toBe(`${dateTitle(pending.time.created)}-Brief`)
  })
}
