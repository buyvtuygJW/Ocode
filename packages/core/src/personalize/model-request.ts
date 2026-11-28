import { canonicalMessages, copyWith } from "./content"
import { personaLead, stripStockIdentity } from "./persona"
import { Context, Effect, Layer } from "effect"
import { capRequest } from "./output-request"
import { withDecayPolicy } from "./decay-policy"
type SystemBlock = ReturnType<typeof import("../session/model-request").baseTranscript>["system"][number]

export function personalizeSystem(system: readonly SystemBlock[]): SystemBlock[] {
  const persona = personaLead()
  if (!persona || !system[0]) return [...system]
  return [copyWith(system[0], { text: [persona, stripStockIdentity(system[0].text)].filter(Boolean).join("\n") }), ...system.slice(1)]
}

export function decorate(stock: typeof import("../session/model-request")) {
  const baseTranscript: typeof stock.baseTranscript = (...args) => {
    const result = withDecayPolicy(args[0].model, () => stock.baseTranscript(...args))
    return { ...result, system: personalizeSystem(result.system) }
  }
  const unsupportedParts: typeof stock.unsupportedParts = (messages, ...rest) => stock.unsupportedParts(canonicalMessages(messages), ...rest)
  const boundImages: typeof stock.boundImages = (messages, ...rest) => stock.boundImages(canonicalMessages(messages), ...rest)

  // Call-echo guard REMOVED (2026-11-02), two reasons, both proven live:
  // 1. It signed calls via `input.call.arguments`, but the ToolCall event
  //    carries parsed arguments at `.input` — every signature degenerated to
  //    `name(null)`, so ANY adjacent same-tool pair collided. Different
  //    reads, different greps, and authorized parallel spawns were all
  //    replaced with a fake receipt instead of executing.
  // 2. Even with correct signatures, an intentional parallel spawn is
  //    observationally identical to a blind echo (adjacent calls, no result
  //    between them yet) — the guard cannot tell them apart, so it must not
  //    block. Parallel same-turn tool calls are authorized by the operator.
  // executeTool still passes through stock untouched. The layer only limits
  // model output; no call signatures, deduplication or fake tool receipts.

  const node = stock.node.mapLayer((layer) => layer.pipe(Layer.flatMap((context) => {
    const service = Context.get(context, stock.Service)
    type Interface = import("../session/model-request").Interface
    const primary: Interface["primary"] = (input) => service.primary(input).pipe(Effect.map((value) => ({
      ...value, request: capRequest(value.request, input.model, input.inputTokens && Math.max(input.inputTokens.measured, input.inputTokens.estimated)),
    })))
    const compaction: Interface["compaction"] = (input) => service.compaction(input).pipe(Effect.map((value) => ({
      ...value, request: capRequest(value.request, input.model),
    })))
    const generate: Interface["generate"] = (input) => service.generate(input).pipe(Effect.map((value) => ({
      ...value, request: capRequest(value.request, input.model),
    })))
    const title: Interface["title"] = (input) => service.title(input).pipe(Effect.map((value) => ({
      ...value, request: capRequest(value.request, input.model),
    })))
    return Layer.succeed(stock.Service, { ...service, primary, compaction, generate, title })
  })))

  return { baseTranscript, unsupportedParts, boundImages, node }
}
