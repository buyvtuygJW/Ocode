import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import type { TextareaRenderable } from "@opentui/core"
import type { PermissionRequest } from "@opencode/client"
import { createPermissionController } from "@opencode/schema/personalize/permission-controller"
import { choiceLabel, choices, exactSessionHint, isCommandScope, policyDirectories, policyEditor, readFacts, unknownPolicyTitle, unknownShell } from "@opencode/schema/personalize/permission-policy"
import { createPolicyInput } from "./policy-input"
import { useData } from "../context/data"
import { usePathFormatter } from "../context/path-format"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { useCursorStyle } from "../config"
import { useInteractivity } from "../context/interactivity"
import { Keymap } from "../context/keymap"
import { permissionAlwaysLines, permissionOptionLabel } from "../util/permission"
import { SplitBorder } from "../ui/border"
import type { SessionQuestion, permissionSemanticLabel } from "../routes/session/permission"

/** Own only decision state/navigation. Stock renders request details and diffs. */
export function createPermissionView(
  props: { request: PermissionRequest },
  stock: {
    Question: typeof SessionQuestion
    Reject: (props: { action: string; instance: string; onConfirm: (text: string) => void; onCancel: () => void }) => JSX.Element
    label: typeof permissionSemanticLabel
  },
) {
  const data = useData()
  const pathFormatter = usePathFormatter()
  const theme = useTheme()
  const toast = useToast()
  const [state, setState] = createSignal({ stage: "permission", status: "idle", error: undefined as string | undefined })
  const controller = createPermissionController(props.request, {
    send: (reply) => data.session.permission.reply(reply),
    changed: (next) => setState({ stage: next.stage, status: next.status, error: next.error }),
    report: (error) => toast.error(error),
  })
  onCleanup(() => controller.dispose())
  createEffect(() => { controller.replaceRequest(props.request) })
  const busy = () => state().status !== "idle"
  const unknown = () => unknownShell(props.request)
  const source = createMemo(() => {
    const tool = props.request.source
    if (!tool) return { input: undefined, metadata: undefined }
    const message = data.session.message.get(props.request.sessionID, tool.messageID)
    if (message?.type !== "assistant") return { input: undefined, metadata: undefined }
    const part = message.content.find((part) => part.type === "tool" && part.id === tool.id)
    if (part?.type === "tool" && part.state.status !== "streaming")
      return { input: part.state.input, metadata: part.state.metadata }
    return { input: undefined, metadata: undefined }
  })
  const open = (stage: "permission" | "reject" | "policy") => { if (!busy()) controller.open(stage) }
  function Frame(input: { children: () => JSX.Element }) {
    return (
      <Show when={JSON.stringify([props.request.sessionID, props.request.id])} keyed>
        {(_identity) => (
          <Show when={state().stage === "permission"} fallback={
            <box flexDirection="column">
              <Show when={state().error}><text fg={theme.text.feedback.error.base}>{state().error}</text></Show>
              <Show when={busy()}><text fg={theme.text.muted}>Waiting for permission event…</text></Show>
              <Show when={state().stage === "policy"} fallback={
                <stock.Reject action={props.request.action} instance={props.request.id}
                  onConfirm={(message) => { if (!busy()) controller.submit("reject", message || undefined) }}
                  onCancel={() => open("permission")} />
              }>
                <PolicyInput request={props.request} busy={busy()}
                  onConfirm={(text) => controller.submitPolicy(text)}
                  onCancel={() => open("permission")} />
              </Show>
            </box>
          }>
            {input.children()}
          </Show>
        )}
      </Show>
    )
  }
  function question(input: { header: JSX.Element; body: () => JSX.Element; title?: string }) {
    return (
      <stock.Question title="Permission required" semanticLabel={stock.label(props.request.action, input.title)}
        instance={props.request.id} escapeKey="reject" fullscreen
        header={<box flexDirection="column">
          {input.header}
          <Show when={readFacts(props.request)?.operations.length}>
            <text fg={theme.text.muted}>{readFacts(props.request)!.operations.join("/")}</text>
          </Show>
          <Show when={state().error}><text fg={theme.text.feedback.error.base}>{state().error}</text></Show>
          <Show when={unknown()}><text fg={theme.text.feedback.warning.base}>{unknownPolicyTitle}</text></Show>
          <For each={policyDirectories(props.request)}>{(directory) => <text fg={theme.text.base}>{directory}</text>}</For>
        </box>}
        body={(option) => <><Show when={option === "always"} fallback={input.body()}>
          <box paddingLeft={1} gap={1}>
            <For each={permissionAlwaysLines(props.request)}>
              {(line, index) => <text fg={index() === 0 ? theme.text.muted : theme.text.base}>{line}</text>}
            </For>
          </box>
        </Show><Show when={choices(props.request).includes("Unknown=S")}><text flexShrink={0} fg={theme.text.muted}>{exactSessionHint}</text></Show></>}
        options={Object.fromEntries(choices(props.request).map((choice) =>
          [choice, choiceLabel(choice, unknown(), permissionOptionLabel)]))}
        onSelect={(option) => {
          if (busy()) return
          if (isCommandScope(option)) return controller.submit({ scope: "session", policy: option })
          if (option === "policy") return open("policy")
          if (option === "reject" && !unknown() && data.session.get(props.request.sessionID)?.parentID)
            return open("reject")
          if (option === "once" || option === "always" || option === "reject" || option === "session_read")
            controller.submit(option)
        }} />
    )
  }
  return { source, pathFormatter, Frame, question }
}

function PolicyInput(props: {
  request: PermissionRequest
  busy: boolean
  onConfirm: (text: string) => void
  onCancel: () => void
}) {
  const theme = useTheme()
  const cursor = useCursorStyle()
  const enabled = useInteractivity()
  const editor = createMemo(() => policyEditor(props.request))
  let input: TextareaRenderable | undefined
  const initialize = createPolicyInput(editor, () => props.busy)
  const confirm = () => { if (!props.busy && input) props.onConfirm(input.plainText) }
  const cancel = () => { if (!props.busy) props.onCancel() }
  Keymap.createLayer(() => ({
    mode: "base",
    commands: [
      { bind: "return", title: "Apply permission policy", group: "Permission", run: confirm },
      { bind: "escape", title: "Cancel permission policy", group: "Permission", run: cancel },
      { id: "app.exit", title: "Cancel permission policy", group: "Permission", run: cancel },
    ],
  }))
  return <box flexDirection="column" backgroundColor={theme.background.raised.base}
    border={["left"]} borderColor={theme.text.feedback.error.base} customBorderChars={SplitBorder.customBorderChars}
    paddingLeft={2} paddingRight={3} paddingTop={1} paddingBottom={1} gap={1}>
    <text fg={theme.text.base}>{editor().title}</text>
    <For each={policyDirectories(props.request)}>{(directory) => <text fg={theme.text.base}>{directory}</text>}</For>
    <text fg={theme.text.muted}>{editor().hint}</text>
    <textarea ref={(value) => { input = value; initialize(value) }} minHeight={1} maxHeight={3} focused={enabled() && !props.busy}
      placeholder={editor().placeholder}
      textColor={theme.text.base} focusedTextColor={theme.text.base} cursorColor={theme.text.base} cursorStyle={cursor()} />
    <box flexDirection="row" gap={2}>
      <Show when={editor().presets.length}><text fg={theme.text.muted}>←/→ select</text></Show>
      <text fg={theme.text.base} onMouseUp={confirm}>enter apply policy</text>
      <text fg={theme.text.muted} onMouseUp={cancel}>esc cancel</text>
    </box>
  </box>
}
