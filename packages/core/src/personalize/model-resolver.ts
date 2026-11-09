import { Model } from "../model"
import { Context, Effect, Layer } from "effect"
import { rememberDecayBypass, splitDecaySetting } from "./decay-policy"

export function decorate(stock: typeof import("../model-resolver")) {
  // The stock node already depends on Model.node; mapLayer's generic R cannot
  // express that existing requirement even though the node supplies it.
  const node = stock.node.mapLayer((layer) => layer.pipe(Layer.flatMap((context) => Layer.effect(stock.Service, Effect.gen(function* () {
    const service = Context.get(context, stock.Service)
    const models = yield* Model.Service
    const resolveModel: typeof service.resolveModel = (selected, variant) => {
      const split = splitDecaySetting(selected)
      // Variant-level overrides are not supported: remove the client-only key
      // there too, so it can never leak to the provider.
      const variants = split.model.variants?.map((item) => splitDecaySetting(item).model)
      const cleaned = variants ? { ...split.model, variants } : split.model
      return service.resolveModel(cleaned, variant).pipe(Effect.map((resolved) => rememberDecayBypass(resolved, split.bypass)))
    }
    const resolve: typeof service.resolve = Effect.fn("PersonalizeModelResolver.resolve")(function* (requested) {
      const selected = requested
        ? yield* models.get(requested.providerID, requested.id)
        : yield* models.default().pipe(Effect.flatMap((model) =>
            model && stock.hasPackage(model)
              ? Effect.succeed(model)
              : Effect.map(models.available(), (all) => all.find((model) => stock.hasPackage(model) && Model.supportsText(model))),
          ))
      if (!selected) return undefined
      return yield* resolveModel(selected, requested?.variant)
    })
    return stock.Service.of({ ...service, resolve, resolveModel })
  })))) as typeof layer)
  return { node }
}
