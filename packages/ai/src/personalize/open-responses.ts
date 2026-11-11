import { Effect } from "effect"

export function decorate(stock: typeof import("../protocols/open-responses")) {
  const lowerGeneration: typeof stock.lowerGeneration = (...args) => ({ ...stock.lowerGeneration(...args), store: false })
  const fromRequest: typeof stock.fromRequest = (...args) =>
    stock.fromRequest(...args).pipe(Effect.map((body) => ({ ...body, store: false })))
  const fromRequestWithAdapter: typeof stock.fromRequestWithAdapter = (...args) =>
    stock.fromRequestWithAdapter(...args).pipe(Effect.map((body) => ({ ...body, store: false })))
  return {
    lowerGeneration, fromRequest, fromRequestWithAdapter,
    protocol: { ...stock.protocol, body: { ...stock.protocol.body, from: fromRequest } },
  }
}
