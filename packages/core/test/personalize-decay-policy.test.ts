import { expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { Model } from "../src/model"
import { decorate } from "../src/personalize/model-resolver"
import { bypassDecay, rememberDecayBypass, splitDecaySetting, withDecayPolicy } from "../src/personalize/decay-policy"

test("the decay opt-in is strict, model-scoped and removed from provider settings", () => {
  const selected = { settings: { baseURL: "http://localhost", ocodeContextDecay: false } }
  const split = splitDecaySetting(selected)
  expect(split.bypass).toBe(true)
  expect(split.model.settings.baseURL).toBe("http://localhost")
  expect("ocodeContextDecay" in split.model.settings).toBe(false)
  expect(selected.settings.ocodeContextDecay).toBe(false)
  expect(splitDecaySetting({ settings: { baseURL: "x" } }).bypass).toBe(false)
  expect(splitDecaySetting({ settings: { ocodeContextDecay: true } }).bypass).toBe(false)
  expect(() => splitDecaySetting({ settings: { ocodeContextDecay: "false" } })).toThrow()
  const enabled = rememberDecayBypass({}, true)
  const normal = {}
  expect(withDecayPolicy(enabled, bypassDecay)).toBe(true)
  expect(withDecayPolicy(normal, bypassDecay)).toBe(false)
  expect(bypassDecay()).toBe(false)
})

test("the resolver strips the opt-in on direct and ordinary resolution", async () => {
  const selected = {
    id: "sol", providerID: "proxy", settings: { baseURL: "http://localhost", ocodeContextDecay: false },
    variants: [{ id: "v", settings: { ocodeContextDecay: false, temperature: 1 } }],
  }
  const catalog = { get: () => Effect.succeed(selected), default: () => Effect.succeed(selected), available: () => Effect.succeed([selected]) }
  const tag = Context.Service("personalize-test-resolver")
  const service = { resolve: () => Effect.die("unexpected stock resolve"), resolveModel: (model: unknown) => Effect.succeed({ model }), untouched: 42 }
  const stock: any = { Service: tag, hasPackage: () => true, node: { mapLayer: (f: any) => ({ layer: f(Layer.succeed(tag, service)) }) } }
  const node: any = decorate(stock).node
  const program = Effect.gen(function* () {
    const resolver: any = yield* tag
    expect(resolver.untouched).toBe(42)
    const direct = yield* resolver.resolveModel(selected)
    expect(direct.model.settings).toEqual({ baseURL: "http://localhost" })
    expect(direct.model.variants[0].settings).toEqual({ temperature: 1 })
    expect(withDecayPolicy(direct, bypassDecay)).toBe(true)
    const explicit = yield* resolver.resolve({ providerID: "proxy", id: "sol" })
    expect(withDecayPolicy(explicit, bypassDecay)).toBe(true)
    const fallback = yield* resolver.resolve()
    expect(withDecayPolicy(fallback, bypassDecay)).toBe(true)
    const normal = yield* resolver.resolveModel({ ...selected, settings: { baseURL: "x" } })
    expect(withDecayPolicy(normal, bypassDecay)).toBe(false)
  }).pipe(Effect.provide(node.layer), Effect.provide(Layer.succeed(Model.Service, catalog as any)))
  await Effect.runPromise(program as Effect.Effect<void, never, never>)
})
