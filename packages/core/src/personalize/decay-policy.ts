import { AsyncLocalStorage } from "node:async_hooks"

// Per-resolved-model policy, not a URL or provider-name heuristic. Keeping the
// marker out of the model avoids passing a client option to provider SDKs.
const bypass = new WeakSet<object>()
const scope = new AsyncLocalStorage<boolean>()

export const rememberDecayBypass = <T extends object>(model: T, enabled: boolean): T => {
  if (enabled) bypass.add(model)
  return model
}

export const withDecayPolicy = <T>(model: object, run: () => T): T => scope.run(bypass.has(model), run)
export const bypassDecay = () => scope.getStore() === true

/** Strip the client-only setting before constructing a provider model. */
export function splitDecaySetting<T extends { readonly settings?: Readonly<Record<string, unknown>> }>(model: T) {
  const settings = model.settings
  if (!settings || !("ocodeContextDecay" in settings)) return { model, bypass: false }
  const { ocodeContextDecay, ...rest } = settings
  if (typeof ocodeContextDecay !== "boolean") throw new TypeError("ocodeContextDecay must be a boolean")
  return { model: { ...model, settings: rest }, bypass: ocodeContextDecay === false }
}
