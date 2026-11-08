import { Context, Effect, Layer } from "effect"
import { canonicalMessages, copyWith } from "./content"
import { personalizeSystem } from "./model-request"

export function decorate(stock: typeof import("../plugin/hooks")) {
  return { node: stock.node.mapLayer((layer) => Layer.effectContext(Effect.map(Layer.build(layer), (context) => {
    const original = Context.get(context, stock.Service)
    const trigger: typeof original.trigger = (domain, name, event) => Effect.suspend(() => {
      if (domain !== "session" || !["context", "compaction", "generate", "title"].includes(String(name))) {
        return original.trigger(domain, name, event)
      }
      const before = event as unknown as { system?: unknown; messages?: unknown }
      const system = Array.isArray(before.system) ? [...before.system] : []
      const messages = canonicalMessages(before.messages)
      return original.trigger(domain, name, event).pipe(Effect.map((result) => {
        const value = result as unknown as { system?: unknown; messages?: unknown; result?: unknown }
        const shaped = copyWith(value, {
          system: personalizeSystem(Array.isArray(value.system) ? value.system : system),
          messages: canonicalMessages(Array.isArray(value.messages) ? value.messages : messages),
        })
        if (name === "title" && typeof shaped.result !== "string") {
          const first = canonicalMessages(shaped.messages).find((message) => message.role === "user")
          const text = first?.content.filter((part) => part.type === "text").map((part) => part.text).join(" ") || "New session"
          const title = text.replace(/\s+/g, " ").trim()
          shaped.result = title.length > 50 ? title.slice(0, 50) + "…" : title
        }
        return shaped as typeof result
      }))
    })
    return Context.add(context, stock.Service, { ...original, trigger })
  }))) }
}
