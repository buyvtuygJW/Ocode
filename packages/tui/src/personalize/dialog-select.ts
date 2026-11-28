import { InputRenderable, type KeyBinding } from "@opentui/core"
import { extend } from "@opentui/solid"
import { createComponent, createContext, useContext } from "solid-js"

const Filter = createContext(false)
class FilterInput extends InputRenderable {
  constructor(...[renderer, options]: ConstructorParameters<typeof InputRenderable>) {
    super(renderer, useContext(Filter) ? { ...options, keyBindings: [
      ...(options.keyBindings ?? []),
      { name: "a", ctrl: true, action: "opencode:pass-through" },
    ] as unknown as KeyBinding[] } : options)
  }
}
// Public Solid extension API; non-dialog input behavior is left byte-identical.
extend({ input: FilterInput })

export function decorate(stock: typeof import("../ui/dialog-select")) {
  const DialogSelect: typeof stock.DialogSelect = (props) => createComponent(Filter.Provider, {
    value: true,
    get children() { return createComponent(stock.DialogSelect, props) },
  })
  return { DialogSelect }
}
