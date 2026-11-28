import { Message, SystemPart } from "@opencode/ai/effect"
import { TextBoundary } from "@opencode/util/text-boundary"
import { Effect } from "effect"
import type { SessionContext } from "../session/context.js"

// User-approved naming policy. Hooks still run, and their redactions are kept.
const instruction = "Summarize: one word, max 5 chars, no spaces."
const outputLimit = 20
const outputTokenKeys = new Set([
  "maxTokens", "maxOutputTokens", "maxCompletionTokens", "max_tokens",
  "max_output_tokens", "max_completion_tokens", "max_tokens_to_sample",
])

export const prepareTitle = Effect.fn("Personalize.prepareTitle")(function* (
  context: SessionContext.Interface,
  input: Parameters<SessionContext.Interface["request"]["title"]>[0],
) {
  const prepared = yield* context.request.title({ ...input, system: [SystemPart.make(instruction)] })
  const safeText = prepared.request.messages
    .flatMap((message) => message.role === "user" ? message.content : [])
    .flatMap((part) => part.type === "text" ? [part.text] : [])
    .join(" ")
  const { maxTokens: requestedMaxTokens, ...request } = prepared.request
  const baseURL = request.model.route.endpoint.baseURL
  const codex = baseURL && URL.canParse(baseURL) && new URL(baseURL).origin === "https://chatgpt.com" &&
    new URL(baseURL).pathname.startsWith("/backend-api/codex")
  const maxTokens = codex ? undefined : Math.min(requestedMaxTokens ?? outputLimit, outputLimit)
  const providerOptions = codex || !request.providerOptions
    ? request.providerOptions
    : Object.fromEntries(Object.entries(request.providerOptions).map(([key, value]) => [
        key,
        outputTokenKeys.has(key) && typeof value === "number" ? Math.min(value, outputLimit) : value,
      ]))
  return {
    ...prepared,
    request: {
      ...request,
      ...(maxTokens === undefined ? {} : { maxTokens }),
      providerOptions,
      system: [SystemPart.make(instruction)],
      messages: [Message.user(TextBoundary.head(safeText, 1_000))],
    },
  }
})
