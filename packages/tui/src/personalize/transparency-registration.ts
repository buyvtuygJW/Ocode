import type { Plugin } from "@opencode/plugin/tui"

// Keep this helper independent of host UI state. A reloadable external plugin
// may import it without pulling providers into the plugin's invalidation graph.
export function registerTransparency(context: Plugin.Context, toggle: () => void) {
  context.keymap.layer(() => ({
    mode: "global",
    commands: [{
      id: "theme.transparent", title: "Toggle transparency", group: "System", palette: true, run: toggle,
    }],
    // Use the configured binding, including "none"; no inline fallback may
    // reactivate a key the user disabled.
    bindings: ["theme.transparent"],
  }))
}
