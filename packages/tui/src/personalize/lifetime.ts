import { Plugin } from "@opencode/plugin/tui"
import { useKeyboard } from "@opentui/solid"
import { createEffect, createRoot } from "solid-js"
import { defaults, duration } from "@opencode/util/personalize-lifetime"
import { useClient } from "../context/client"
import { wake } from "./lifetime-state"

const commands = [
  {
    name: "killtime", key: "hardMs", title: "Hard shutdown timeout",
    description: "Force-kill after the last window disconnects (default 20s). A custom hard deadline takes priority over soft waiting and kills unfinished work.",
  },
  {
    name: "softkilltime", key: "softMs", title: "Soft shutdown timeout",
    description: "Wait for all tasks, subagents and background tools, then stop after this quiet time (default 10s). Never delays the hard deadline.",
  },
] as const

const plugin = Plugin.define({
  id: "opencode.personalize.lifetime",
  setup(context) {
    context.ui.slot({
      append: "app",
      render() {
        const client = useClient()
        useKeyboard(() => wake.wake())
        context.keymap.layer(() => ({
          mode: "global",
          commands: commands.map((command) => ({
            id: `personalize.${command.name}`,
            title: command.title,
            description: command.description,
            group: "Service",
            palette: true,
            slash: { name: command.name, arguments: true },
            async run(input) {
              try {
                const value = input?.trim()
                if (value) duration(value, defaults[command.key])
                wake.wake()
                if (client.connection.status() !== "connected") {
                  // Wait for the existing reconnect path, never spawn ourselves.
                  await new Promise<void>((resolve, reject) => {
                    createRoot((dispose) => {
                      const timer = setTimeout(() => { dispose(); reject(new Error("Server did not reconnect")) }, 120_000)
                      createEffect(() => {
                        if (client.connection.status() !== "connected") return
                        clearTimeout(timer); dispose(); resolve()
                      })
                    })
                  })
                }
                if (!client.url) throw new Error("A managed local server is required")
                const response = await fetch(new URL("/_personalize/lifetime", client.url), {
                  method: value ? "PUT" : "GET",
                  headers: { ...client.headers, "Content-Type": "application/json" },
                  body: value ? JSON.stringify({ command: command.name, duration: value }) : undefined,
                })
                const body: unknown = await response.json()
                if (!response.ok) throw new Error(body && typeof body === "object" ? String(Reflect.get(body, "error")) : "Lifetime command failed")
                if (!body || typeof body !== "object") throw new Error("Invalid lifetime response")
                const ms = Number(Reflect.get(body, command.key))
                context.ui.toast.show({
                  variant: "info",
                  message: `/${command.name}: ${ms / 1000}s. ${command.description}`,
                })
              } catch (error) {
                context.ui.toast.show({ variant: "error", message: error instanceof Error ? error.message : String(error) })
              }
            },
          })),
        }))
        return null
      },
    })
  },
})

export function decorate(stock: typeof import("../plugin/builtins")) {
  return { builtins: [...stock.builtins, plugin] }
}
