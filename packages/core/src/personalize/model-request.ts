import { Context, Effect, Layer } from "effect"
import { canonicalMessages, copyWith } from "./content"
import { personaLead, stripStockIdentity } from "./persona"
import { bumpLedger, callSignature, estimateTokens, punchLine, slapReceipt } from "./dedup"

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

  // Guard 1 (deltav11): adjacent duplicate tool calls get a *Systemslap*
  // receipt instead of execution. executeTool runs once per tool-call event
  // in stream order, so a closure over the previous signature flags exactly
  // the blind-echo shape: the model re-emitted a call before any result
  // could exist. A different call in between, or a later step (fresh
  // Prepared), is informed repetition and stays legal.
  const guardPrepared = <P extends { readonly executeTool: (input: any) => any; readonly [key: string]: unknown }>(prepared: P): P => {
    let lastSignature: string | undefined
    let callNumber = 0
    return {
      ...prepared,
      executeTool: (input: any) => {
        callNumber += 1
        const signature = callSignature(input?.call?.name, input?.call?.arguments)
        if (signature === lastSignature) {
          const wasted = estimateTokens(signature)
          const entry = bumpLedger(String(input?.sessionID ?? ""), "calls", wasted)
          const receipt = slapReceipt(callNumber, wasted, punchLine(entry))
          return Effect.succeed({ content: [{ type: "text" as const, text: receipt }] })
        }
        lastSignature = signature
        return prepared.executeTool(input)
      },
    } as P
  }

  // Same node-wrapping pattern as the owned hooks factory: build the stock
  // layer, wrap the service inside its context, keep dependency wiring and
  // the service contract intact (mapLayer preserves the node's deps).
  const node: typeof stock.node = stock.node.mapLayer((layer) =>
    Layer.effectContext(Effect.map(Layer.build(layer), (context) => {
      const original = Context.get(context, stock.Service)
      return Context.add(
        context,
        stock.Service,
        {
          ...original,
          primary: (input: Parameters<typeof original.primary>[0]) => Effect.map(original.primary(input), guardPrepared),
          compaction: (input: Parameters<typeof original.compaction>[0]) => Effect.map(original.compaction(input), guardPrepared),
          generate: (input: Parameters<typeof original.generate>[0]) => Effect.map(original.generate(input), guardPrepared),
          title: (input: Parameters<typeof original.title>[0]) => Effect.map(original.title(input), guardPrepared),
        },
      )
    })),
  )

  return { baseTranscript, unsupportedParts, boundImages, node }
}
