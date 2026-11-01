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
    // Retain the upstream ambient surface. Only aliases of the base background
    // become transparent; explicit selection/diff/dialog backgrounds stay intact.
    const cache = new WeakMap<object, object>()
    const view = <T extends object>(value: T): T => {
      const existing = cache.get(value)
      if (existing) return existing as T
      const wrapped = new Proxy(value, { get(target, key, receiver) {
        const item = Reflect.get(target, key, receiver)
        if (item instanceof RGBA) return facade.transparent() && item === source.currentTokens().background.base ? NONE : item
        return item && typeof item === "object" ? view(item) : item
      } })
      cache.set(value, wrapped)
      return wrapped
    }
    return view(theme)
  }
  return { useThemes, useTheme }
}
