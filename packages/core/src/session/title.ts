export * as SessionTitle from "./title.js"

import { isDeepStrictEqual } from "node:util"
import { LLMClient, LLMEvent, Message, SystemPart } from "@opencode/ai/effect"
import type { Agent } from "@opencode/schema/agent"
import { Context, Data, DateTime, Effect, Layer, Stream } from "effect"
import { Database } from "../database/database.js"
import { Bus } from "../bus.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { isExactRootFallback } from "@opencode/util/session-title-fallback"
import { TextBoundary } from "@opencode/util/text-boundary"
import { llmClient } from "../effect/app-node-platform.js"
import { SessionContext } from "./context.js"
import { SessionEvent } from "./event.js"
import { SessionHistory } from "./history.js"
import type { SessionRunnerModel } from "./runner/model.js"
import { SessionSchema } from "./schema.js"
import { SessionUsage } from "./usage.js"
import { SessionStore } from "./store.js"
import { dateTitle, createTitleRenamer } from "../personalize/session-naming.js"
import { prepareTitle } from "../personalize/title-request.js"

// The title moved on while the model was naming it; the newer title wins.
class TitleChanged extends Data.TaggedError("SessionTitle.TitleChanged") {}

export interface Interface {
  /** Generates or regenerates a dated title from the bounded first user message. */
  readonly generate: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTitle") {}

export const isUntitled = (session: SessionSchema.Info) =>
  session.title === dateTitle(session.time.created) ||
  isExactRootFallback({
    title: session.title,
    time: { created: DateTime.toEpochMillis(session.time.created) },
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const llm = yield* LLMClient.Service
    const context = yield* SessionContext.Service
    const store = yield* SessionStore.Service
    const db = (yield* Database.Service).db

    const attempt = Effect.fn("SessionTitle.attempt")(function* (input: {
      readonly session: SessionSchema.Info
      readonly agent: Agent.Info
      readonly text: string
      readonly model: SessionRunnerModel.Resolved
    }) {
      const chunks: Array<{ id: string; text: string }> = []
      const commentary = new Set<string>()
      let failed = false
      let usage: SessionUsage.Recorded | undefined
      const recordUsage = Effect.suspend(() =>
        usage
          ? bus.publish(SessionEvent.UsageRecorded, {
              sessionID: input.session.id,
              source: "title",
              ...usage,
            })
          : Effect.void,
      )
      const prepared = yield* prepareTitle(context, {
        session: input.session,
        agent: input.agent.id,
        model: input.model,
        system: input.agent.system ? [SystemPart.make(input.agent.system)] : [],
        messages: [Message.user(input.text)],
      })
      if (prepared.event.result !== undefined) return prepared.event.result
      const metadataKey = prepared.request.model.route.providerMetadataKey ?? prepared.request.model.provider
      yield* llm.stream(prepared.request, prepared.options).pipe(
        Stream.runForEach((event) => {
          // Responses can classify a text block only when it ends; filter after the stream completes.
          if (LLMEvent.is.textStart(event) || LLMEvent.is.textDelta(event) || LLMEvent.is.textEnd(event)) {
            const phase = event.providerMetadata?.[metadataKey]?.phase
            if (phase === "commentary") commentary.add(event.id)
            if (phase === "final_answer" || phase === null) commentary.delete(event.id)
          }
          if (LLMEvent.is.textDelta(event)) chunks.push({ id: event.id, text: event.text })
          if (LLMEvent.is.stepFinish(event)) {
            const step = SessionUsage.record(event.usage, input.model.cost)
            usage = usage ? SessionUsage.add(usage, step) : step
          }
          return Effect.void
        }),
        Effect.catchTag("AI.Error", () =>
          Effect.sync(() => {
            failed = true
          }),
        ),
        Effect.onInterrupt(() => recordUsage.pipe(Effect.asVoid)),
      )
      yield* recordUsage
      if (failed) return
      return chunks
        .filter((chunk) => !commentary.has(chunk.id))
        .map((chunk) => chunk.text)
        .join("")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
    })

    const generate = Effect.fn("SessionTitle.generate")(function* (sessionID: SessionSchema.ID) {
      const rename = createTitleRenamer({ bus, store, db, conflict: () => new TitleChanged() })
      let session = yield* store.get(sessionID)
      if (!session) return
      // Persist the date before model selection, streaming, or any early return.
      // A failure must not leave the UI's plain "New session" fallback behind.
      if (isUntitled(session)) {
        const title = dateTitle(session.time.created)
        const renamed = yield* rename(session, title)
        if (!renamed) return
        session = { ...session, title }
      }
      const firstUser = yield* SessionHistory.firstUserMessage(db, session.id)
      if (!firstUser) return
      const text = TextBoundary.head(firstUser.text, 1_000)
      const selection = yield* context.selectTitle(session)
      if (!selection) return
      const generated =
        (yield* attempt({ session, agent: selection.agent, text, model: selection.selected })) ??
        (selection.primary && !isDeepStrictEqual(selection.selected.ref, selection.primary.ref)
          ? yield* attempt({ session, agent: selection.agent, text, model: selection.primary })
          : undefined)
      if (!generated) return
      const stamp = dateTitle(session.time.created)
      const pseudonym = /^[\p{L}\p{N}]{1,5}$/u.test(generated) ? generated : ""
      const title = pseudonym ? `${stamp}-${pseudonym}` : stamp
      yield* rename(session, title)
    })
    return Service.of({ generate })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, llmClient, SessionContext.node, SessionStore.node, Database.node],
})
