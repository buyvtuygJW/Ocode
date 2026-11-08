import { useThemes } from "../context/theme"

export function decorate(stock: typeof import("../context/keymap")) {
  const createLayer: typeof stock.Keymap.createLayer = (input) => {
    // The app registers its global command-palette layer inside both providers.
    // No edits to its private command list or component body are necessary.
    let theme: ReturnType<typeof useThemes> & { toggleTransparent?: () => void }
    try { theme = useThemes() } catch { return stock.Keymap.createLayer(input) }
    return stock.Keymap.createLayer(() => {
      const layer = input()
      if (layer.mode !== "global" || !layer.commands?.some((item) => item.id === stock.COMMAND_PALETTE_COMMAND)) return layer
      return { ...layer, commands: [...layer.commands, {
        id: "theme.transparent", title: "Toggle transparency", group: "System", palette: true,
        run: () => theme.toggleTransparent?.(),
      }], bindings: [...(layer.bindings ?? []), "theme.transparent"] }
    })
  }
  return { Keymap: { ...stock.Keymap, createLayer } }
}
