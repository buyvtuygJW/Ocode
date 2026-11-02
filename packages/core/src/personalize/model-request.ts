import { canonicalMessages, copyWith } from "./content"
import { personaLead, stripStockIdentity } from "./persona"

export function personalizeSystem<T extends { readonly content: string }>(system: readonly T[]): T[] {
  const persona = personaLead()
  if (!persona || !system[0]) return [...system]
  return [copyWith(system[0], { content: [persona, stripStockIdentity(system[0].content)].filter(Boolean).join("\n") }), ...system.slice(1)]
}

export function decorate(stock: typeof import("../session/model-request")) {
  const baseTranscript: typeof stock.baseTranscript = (...args) => {
    const result = stock.baseTranscript(...args)
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
  // executeTool passes through stock untouched; the node stays the stock
  // layer. The prose-echo half of dedup.ts is unaffected.

  return { baseTranscript, unsupportedParts, boundImages, node: stock.node }
}
