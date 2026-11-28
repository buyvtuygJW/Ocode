import { InputRenderable } from "@opentui/core"
import { expect, test } from "bun:test"
import { takeDraft } from "../src/component/prompt/draft-stash"
import { ConfigProvider, useConfig } from "../src/config"
import { ThemeProvider, useThemes } from "../src/context/theme"
import { TuiKeybind } from "../src/config/keybind"
import { decorate } from "../src/personalize/keybind"
import { createAppFixture } from "./fixture/app"
import { tmpdir } from "./fixture/fixture"

test("transparency command uses native plugin keyboard/palette registration and unloads", async () => {
  takeDraft(undefined)
  const providerDefault = TuiKeybind.Definitions["model.dialog.provider"].default
  // Apply the separate, still-counted keybind data customization. The stock
  // keymap implementation and plugin host are not replaced.
  decorate(TuiKeybind)
  try {
    await using plugin = await tmpdir()
    const registration = new URL("../src/personalize/transparency-registration.ts", import.meta.url).href
    await Bun.write(`${plugin.path}/tui.ts`, `
      import { registerTransparency } from ${JSON.stringify(registration)}
      export default {
        id: "fixture.transparency",
        setup(context) {
          let count = 0
          registerTransparency(context, () => context.ui.toast.show({
            message: "Transparency toggled " + ++count, variant: "info", duration: 60000,
          }))
          context.ui.toast.show({ message: "Transparency ready", variant: "info" })
        },
      }
    `)
    await using setup = await createAppFixture({ config: { animations: false, plugins: [plugin.path] } })
    await setup.ready
    await setup.waitForFrame((frame) => frame.includes("Transparency ready"))
    // Loading this fixture must not evict host contexts. Previously its local
    // dependency graph included keymap -> theme -> config, splitting providers
    // from consumers in every subsequently loaded test file.
    const config = await import("../src/config")
    const theme = await import("../src/context/theme")
    expect(config.ConfigProvider).toBe(ConfigProvider)
    expect(config.useConfig).toBe(useConfig)
    expect(theme.ThemeProvider).toBe(ThemeProvider)
    expect(theme.useThemes).toBe(useThemes)
    setup.mockInput.pressKey("t", { meta: true })
    await setup.waitForFrame((frame) => frame.includes("Transparency toggled 1"))

    const search = async () => {
      setup.mockInput.pressKey("p", { ctrl: true })
      await setup.waitForFrame((frame) => frame.includes("Commands"))
      await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
      await setup.mockInput.typeText("Toggle transparency")
    }
    await search()
    await setup.waitForFrame((frame) => frame.includes("Toggle transparency"))
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("Transparency toggled 2"))

    await setup.mockInput.typeText("/plugins")
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("fixture.transparency"))
    await setup.waitFor(() => setup.renderer.currentFocusedEditor instanceof InputRenderable)
    await setup.mockInput.typeText("fixture.transparency")
    await setup.waitForFrame((frame) => frame.includes("disable"))
    setup.mockInput.pressEnter()
    await setup.waitForFrame((frame) => frame.includes("inactive"))
    setup.mockInput.pressEscape()
    setup.mockInput.pressKey("t", { meta: true })
    await search()
    await setup.waitForFrame((frame) => frame.includes("No results found"))
    expect(setup.captureCharFrame()).not.toContain("Transparency toggled 3")
  } finally {
    Reflect.deleteProperty(TuiKeybind.Definitions, "theme.transparent")
    Reflect.deleteProperty(TuiKeybind.Descriptions, "theme.transparent")
    TuiKeybind.Definitions["model.dialog.provider"].default = providerDefault
  }
}, 30000)
