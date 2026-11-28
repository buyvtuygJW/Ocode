import type { TextareaRenderable } from "@opentui/core"
import { createSignal } from "solid-js"
import { createPolicyPicker, type policyEditor } from "@opencode/schema/personalize/permission-policy"
import { Keymap } from "../context/keymap"

export function createPolicyInput(editor: () => ReturnType<typeof policyEditor>, busy: () => boolean) {
  const [target, setTarget] = createSignal<TextareaRenderable>()
  const pick = createPolicyPicker()
  function shift(direction: -1 | 1) {
    const input = target()
    if (!input) return false
    const next = pick(editor(), input.plainText, direction)
    if (!next) return false // keep native cursor movement during manual editing
    input.setText(next)
    input.cursorOffset = next.endsWith(" Whole=") ? next.indexOf(" ") : next.length
  }
  Keymap.createLayer(() => ({
    target,
    priority: 1,
    enabled: !!target() && !busy() && !!editor().initial,
    commands: [
      { bind: "left", title: "Previous permission rule", group: "Permission", run: () => shift(-1) },
      { bind: "right", title: "Next permission rule", group: "Permission", run: () => shift(1) },
    ],
  }))
  return (input: TextareaRenderable) => {
    const initial = editor().initial
    input.setText(initial)
    input.cursorOffset = initial ? "Unknown=".length : 0
    setTarget(input)
  }
}
