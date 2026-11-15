export * as SessionTitle from "./title.js"

import { isDeepStrictEqual } from "node:util"
import { LLMClient, LLMEvent, Message, SystemPart } from "@opencode/ai/effect"
import type { Agent } from "@opencode/schema/agent"
import { Context, DateTime, Effect, Layer, Stream } from "effect"
import { Database } from "../database/database.js"
import { Bus } from "../bus.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { isExactRootFallback } from "@opencode/util/session-title-fallback"
import { llmClient } from "../effect/app-node-platform.js"
import { SessionContext } from "./context.js"
import { SessionEvent } from "./event.js"
import { SessionHistory } from "./history.js"
import type { SessionRunnerModel } from "./runner/model.js"
import { SessionSchema } from "./schema.js"
import { SessionUsage } from "./usage.js"
import { SessionStore } from "./store.js"

const MAX_LENGTH = 100
const MAX_FIRST_MESSAGE_LENGTH = 1_000
const MAX_TITLE_OUTPUT_TOKENS = 20
const outputTokenKeys = new Set([
  "maxTokens",
  "maxOutputTokens",
  "maxCompletionTokens",
  "max_tokens",
  "max_output_tokens",
  "max_completion_tokens",
  "max_tokens_to_sample",
])
const titleChanged = Symbol("Session title changed")

export interface Interface {
  /** Generates an initial title or regenerates one from bounded conversation history. */
  readonly generate: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTitle") {}

const truncate = (value: string) => (value.length <= MAX_LENGTH ? value : `${value.slice(0, MAX_LENGTH - 3)}...`)
// User-approved naming change: never change session naming without explicit approval.
const instruction = "Summarize: one word, max 5 chars, no spaces."
const dateTitle = (created: DateTime.Utc) => {
  const date = new Date(DateTime.toEpochMillis(created))
  const two = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}-${two(date.getHours())}${two(date.getMinutes())}`
}
export const isUntitled = (session: SessionSchema.Info) =>
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
      const prepared = yield* context.request.title({
        session: input.session,
        agent: input.agent.id,
        model: input.model,
        system: [SystemPart.make(instruction)],
        messages: [Message.user(input.text)],
      })
      if (prepared.event.result !== undefined) return prepared.event.result
      const metadataKey = prepared.request.model.route.providerMetadataKey ?? prepared.request.model.provider
      // Preserve hook redactions and cap the first message separately from the instruction.
      const safeText = prepared.request.messages
        .flatMap((message) => (message.role === "user" ? message.content : []))
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join(" ")
      const safePrompt = safeText.slice(0, MAX_FIRST_MESSAGE_LENGTH)
      const { maxTokens: requestedMaxTokens, ...withoutOutputLimit } = prepared.request
      const baseURL = prepared.request.model.route.endpoint.baseURL
      const codex = baseURL && URL.canParse(baseURL) && new URL(baseURL).origin === "https://chatgpt.com" &&
        new URL(baseURL).pathname.startsWith("/backend-api/codex")
      const maxTokens = codex ? undefined : Math.min(requestedMaxTokens ?? MAX_TITLE_OUTPUT_TOKENS, MAX_TITLE_OUTPUT_TOKENS)
      const providerOptions = codex || !prepared.request.providerOptions
        ? prepared.request.providerOptions
        : Object.fromEntries(Object.entries(prepared.request.providerOptions).map(([key, value]) => [
            key,
            outputTokenKeys.has(key) && typeof value === "number" ? Math.min(value, MAX_TITLE_OUTPUT_TOKENS) : value,
          ]))
      yield* llm.stream(
        { ...withoutOutputLimit, ...(maxTokens === undefined ? {} : { maxTokens }), providerOptions, system: [SystemPart.make(instruction)], messages: [Message.user(safePrompt)] },
        prepared.options,
      ).pipe(
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
      const session = yield* store.get(sessionID)
      if (!session) return
      const firstUser = yield* SessionHistory.firstUserMessage(db, session.id)
      if (!firstUser) return
      const text = firstUser.text.slice(0, MAX_FIRST_MESSAGE_LENGTH)
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
      const expectedSequence = (yield* Bus.latestSequence(db, sessionID)) + 1
      const current = yield* store.get(sessionID)
      if (!current || current.title !== session.title || current.title === truncate(title)) return
      yield* bus
        .publish(
          SessionEvent.Renamed,
          {
            sessionID: session.id,
            title: truncate(title),
          },
          { commit: (sequence) => (sequence === expectedSequence ? Effect.void : Effect.die(titleChanged)) },
        )
        .pipe(Effect.catchDefect((defect) => (defect === titleChanged ? Effect.void : Effect.die(defect))))
    })
    return Service.of({ generate })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, llmClient, SessionContext.node, SessionStore.node, Database.node],
})
