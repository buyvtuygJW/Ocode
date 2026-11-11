import { RGBA } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createComponentTheme } from "../theme/component"
import { useStorageOptional } from "../context/storage"

type Themes = ReturnType<typeof import("../context/theme").useThemes>
const facades = new WeakMap<Themes, ReturnType<typeof facade>>()
const NONE = RGBA.fromInts(0, 0, 0, 0)

function facade(source: Themes) {
  const renderer = useRenderer()
  const storage = useStorageOptional()?.store<{ on?: boolean }>("theme-transparent", { initial: {} })
  const [transparent, setTransparent] = createSignal(storage?.[0].on === true)
  const tokens = createMemo(() => transparent()
    ? { ...source.currentTokens(), background: { ...source.currentTokens().background, base: NONE } }
    : source.currentTokens())
  createEffect(() => renderer.setBackgroundColor(tokens().background.base))
  return { ...source, currentTokens: tokens, current: createComponentTheme(tokens), transparent,
    toggleTransparent() {
      const next = !transparent()
      setTransparent(next)
      void storage?.[1]((draft) => { draft.on = next }).catch(() => {})
    },
  }
}

export function decorate(stock: typeof import("../context/theme")) {
  const useThemes = () => {
    const source = stock.useThemes()
    const existing = facades.get(source)
    if (existing) return existing
    const value = facade(source)
    facades.set(source, value)
    onCleanup(() => facades.delete(source))
    return value
  }
  const useTheme: typeof stock.useTheme = () => {
    const theme = stock.useTheme()
    const source = stock.useThemes()
    const facade = useThemes()
    // Color references can be shared by backgrounds, selection text and hues.
    // Only background tokens may become transparent; never erase a foreground.
    const caches = [new WeakMap<object, object>(), new WeakMap<object, object>()]
    const view = <T extends object>(value: T, background = false): T => {
      const cache = caches[background ? 1 : 0]!
      const existing = cache.get(value)
      if (existing) return existing as T
      const wrapped = new Proxy(value, { get(target, key, receiver) {
        const item = Reflect.get(target, key, receiver)
        if (item instanceof RGBA) return background && facade.transparent() && item === source.currentTokens().background.base ? NONE : item
        return item && typeof item === "object" ? view(item, background || key === "background") : item
      } })
      cache.set(value, wrapped)
      return wrapped
    }
    return view(theme)
  }
  return { useThemes, useTheme }
}
