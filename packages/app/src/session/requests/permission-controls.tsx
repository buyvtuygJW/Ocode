import { For, Show, createEffect, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import type { PermissionDecision, PresenterRequest } from "@opencode/schema/personalize/permission-controller"
import { choices, choiceLabel, createPolicyPicker, exactSessionHint, isCommandScope, policyDirectories, policyDraft, policyEditor, policyError, unknownPolicyTitle, unknownShell, type Choice } from "@opencode/schema/personalize/permission-policy"
import { Button } from "@opencode/ui/button"
import { useLanguage } from "@/runtime/i18n/language"

export interface PermissionControlsProps {
  request: PresenterRequest
  responding: boolean
  onDecide: (response: PermissionDecision) => void
}

// A decision editor, not a replacement for the stock request presentation.
// Keeping the editor with its buttons gives it one owner and one request lifetime.
export function PermissionControls(props: PermissionControlsProps) {
  const language = useLanguage()
  const [policy, setPolicy] = createStore({ text: "", error: "", show: false })
  let actions: HTMLDivElement | undefined
  let custom: HTMLButtonElement | undefined
  let pick = createPolicyPicker()
  let requestKey = ""
  createEffect(() => {
    const key = JSON.stringify([props.request.sessionID, props.request.id])
    if (key === requestKey) return
    requestKey = key
    setPolicy({ text: "", error: "", show: false })
    pick = createPolicyPicker()
    if (unknownShell(props.request)) queueMicrotask(() => {
      if (actions?.isConnected && (document.activeElement === document.body || actions.contains(document.activeElement)))
        actions.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus()
    })
  })
  const unknown = () => unknownShell(props.request)
  const editor = createMemo(() => policyEditor(props.request))
  const options = () => choices(props.request)
  const label = (choice: Choice) =>
    choiceLabel(choice, unknown(), (stock) => {
      if (stock === "once") return language.t("ui.permission.allowOnce")
      if (stock === "always") return language.t("ui.permission.allowAlways")
      return language.t("ui.permission.deny")
    })
  const applyPolicy = () => {
    if (props.responding || !options().includes("policy")) return
    const text = policyDraft(policy.text, unknown())
    if (!text) {
      setPolicy({ show: false, error: "" })
      custom?.focus()
      return
    }
    const error = policyError(text, unknown(), props.request)
    setPolicy("error", error ?? "")
    if (!error) props.onDecide({ scope: "session", policy: text })
  }

  return (
    <div class="flex flex-col gap-2 w-full">
      <Show when={unknown()}><span>{unknownPolicyTitle}</span></Show>
      <Show when={options().includes("policy") && policy.show}>
        <label data-slot="permission-policy">
          <span>{editor().title}</span>
          <For each={policyDirectories(props.request)}>{(directory) => <code>{directory}</code>}</For>
          <input
            ref={(input) => queueMicrotask(() => {
              if (!input.isConnected) return
              input.focus()
              const cursor = editor().initial ? "Unknown=".length : 0
              input.setSelectionRange(cursor, cursor)
            })}
            value={policy.text}
            placeholder={editor().placeholder}
            disabled={props.responding}
            onInput={(event) => setPolicy("text", event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); applyPolicy(); return }
              if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
              const next = pick(editor(), event.currentTarget.value, event.key === "ArrowLeft" ? -1 : 1)
              if (next === undefined) return
              event.preventDefault()
              setPolicy({ text: next, error: "" })
            }}
          />
          <span>{editor().hint}</span>
          <Show when={policy.error}><span role="alert">{policy.error}</span></Show>
        </label>
        <Button variant="neutral" disabled={props.responding} onClick={applyPolicy}>{editor().apply}</Button>
      </Show>
      <Show when={options().includes("Unknown=S")}><span>{exactSessionHint}</span></Show>
      <div ref={actions} data-slot="permission-footer-actions" onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"))
        const index = buttons.findIndex((button) => button.contains(event.target))
        if (index < 0) return
        event.preventDefault()
        const offset = event.key === "ArrowRight" ? 1 : -1
        buttons[(index + offset + buttons.length) % buttons.length]?.focus()
      }}>
        <For each={options()}>
          {(choice) => (
            <Button
              ref={(button: HTMLButtonElement) => { if (choice === "policy") custom = button }}
              variant={choice === "once" ? "submit" : choice === "reject" ? "ghost" : "neutral"}
              size="normal"
              disabled={props.responding}
              onClick={() => {
                if (props.responding) return
                if (choice === "policy") {
                  pick = createPolicyPicker()
                  setPolicy({ text: editor().initial, error: "", show: !policy.show })
                }
                else props.onDecide(isCommandScope(choice) ? { scope: "session", policy: choice } : choice)
              }}
            >
              {label(choice)}
            </Button>
          )}
        </For>
      </div>
    </div>
  )
}
