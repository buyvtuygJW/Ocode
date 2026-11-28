import { Plugin } from "@opencode/plugin/tui"
import { useThemes } from "../context/theme"
import { registerTransparency } from "./transparency-registration"
export { registerTransparency } from "./transparency-registration"

const plugin = Plugin.define({
  id: "opencode.personalize.transparency",
  setup(context) {
    context.ui.slot({
      append: "app",
      render() {
        const theme = useThemes() as ReturnType<typeof useThemes> & { toggleTransparent: () => void }
        registerTransparency(context, () => theme.toggleTransparent())
        return null
      },
    })
  },
})

export function decorate(stock: typeof import("../plugin/builtins")) {
  return { builtins: [...stock.builtins, plugin] }
}
