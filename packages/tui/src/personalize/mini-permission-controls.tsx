/** @jsxImportSource @opentui/solid */
import { TextAttributes, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import { createPermissionController } from "@opencode/schema/personalize/permission-controller"
import { exactSessionHint, policyDirectories, policyEditor, readFacts, unknownPolicyTitle, unknownShell } from "@opencode/schema/personalize/permission-policy"
import { createPolicyInput } from "./policy-input"
import { createPermissionBodyState, permissionCancel, permissionEscape, permissionHover, permissionLabel,
  permissionOptions, permissionReject, permissionRun, permissionShift, type PermissionOption, type PermissionReply } from "./mini-permission"
import type { MiniPermissionRequest } from "../mini/types"
import { transparent, type RunFooterTheme } from "../mini/theme"
import { stringWidth } from "../util/string-width"

type FieldProps = {
  theme: RunFooterTheme; text: string; disabled: boolean
  onChange: (text: string) => void; onConfirm: () => void; onCancel: () => void
}

/** Decision chrome only: the caller retains stock request/diff/scroll rendering. */
export function createMiniPermissionView(
  props: { request: MiniPermissionRequest; theme: RunFooterTheme; mono?: boolean; onReply: (input: PermissionReply) => void | Promise<void> },
  scroll: () => ScrollBoxRenderable | undefined,
  RejectField: (props: FieldProps) => JSX.Element,
) {
  const dims = useTerminalDimensions()
  const [size, setSize] = createSignal(dims())
  const width = () => size().width
  const compact = () => width() < 56 || size().height < 12
  const scrollbar = createMemo(() => ({
    visible: !props.mono,
    trackOptions: { backgroundColor: props.theme.surface, foregroundColor: props.theme.line },
  }))
  const [state, setState] = createSignal(createPermissionBodyState(props.request))
  const controller = createPermissionController(props.request, {
    send: (reply) => props.onReply(reply),
    changed: (next) => setState((prev) => ({ ...prev, stage: next.stage, message: next.message,
      submitting: next.status !== "idle", error: next.error })),
  })
  onCleanup(() => controller.dispose())
  const stage = createMemo(() => state().stage)
  const unknown = () => unknownShell(props.request)
  const editor = createMemo(() => policyEditor(props.request))
  const busy = () => state().submitting
  const opts = createMemo(() => permissionOptions(stage(), props.request))
  const label = (option: PermissionOption) => permissionLabel(option, unknown())
  const controlsWidth = () => opts().reduce((sum, option) => sum + stringWidth(label(option)) + 3, -1)
  const hint = () => compact() && width() < 56 ? "pgup/pgdn scroll"
    : `${props.mono ? "left/right" : "⇆"} select  enter confirm  esc ${stage() === "always" ? "cancel" : "reject"}`
  const inline = () => controlsWidth() + stringWidth(hint()) + 1 <= width() - (compact() ? 0 : 5)
  const title = () => stage() === "policy" ? editor().title : stage() === "always" ? "Always allow"
    : stage() === "reject" ? (width() < 24 ? "Reject" : "Reject permission")
    : width() < 24 ? "Permission" : "Permission required"
  createEffect(() => {
    const request = props.request
    if (state().requestID === request.id && state().sessionID === request.sessionID) return
    setState(createPermissionBodyState(request))
    controller.replaceRequest(request)
  })
  createEffect(() => {
    stage()
    props.request.id
    const current = scroll()
    if (current && !current.isDestroyed) current.scrollTo(0)
  })
  const submit = (reply: PermissionReply) => controller.submit(reply.decision, reply.message)
  const run = (option: PermissionOption) => {
    if (busy() || !opts().includes(option)) return
    if (option === "reject" && unknown() && stage() === "permission") {
      controller.submit("reject")
      return
    }
    const before = state()
    const next = permissionRun(before, props.request.id, option)
    if (next.state !== before) {
      setState(next.state)
      if (next.state.stage !== before.stage) controller.open(next.state.stage)
    }
    if (next.reply) submit(next.reply)
  }
  const confirm = () => {
    if (stage() === "policy") { controller.submitPolicy(); return }
    const reply = permissionReject(state(), props.request.id)
    if (reply) submit(reply)
  }
  const cancel = () => {
    if (busy()) return
    setState((previous) => permissionCancel(previous))
    controller.open("permission")
  }
  useKeyboard((event) => {
    const current = state()
    if (current.stage === "reject" || current.stage === "policy") return
    if (event.name === "pageup" || event.name === "pagedown") {
      scroll()?.scrollBy(event.name === "pageup" ? -1 : 1, "viewport")
      event.preventDefault()
      return
    }
    if (current.submitting) {
      if (["left", "right", "h", "l", "tab", "return", "escape"].includes(event.name)) event.preventDefault()
      return
    }
    const shift = (direction: -1 | 1) => setState((previous) => permissionShift(previous, direction, opts()))
    if (event.name === "tab") shift(event.shift ? -1 : 1)
    else if (event.name === "left" || event.name === "h") shift(-1)
    else if (event.name === "right" || event.name === "l") shift(1)
    else if (event.name === "return") run(state().selected)
    else if (event.name === "escape") {
      if (unknown() && current.stage === "permission") controller.submit("reject")
      else {
        const next = permissionEscape(current)
        setState(next)
        controller.open(next.stage)
      }
    } else return
    event.preventDefault()
  })
  function Frame(input: { children: JSX.Element }) {
    const editing = () => stage() === "reject" || stage() === "policy"
    return <box width="100%" height="100%" minHeight={0} flexDirection="column" backgroundColor={props.theme.surface}
      onSizeChange={function () { setSize({ width: this.width, height: this.height }) }}>
      <box paddingLeft={compact() ? 0 : 2} paddingRight={compact() ? 0 : 3}
        paddingTop={compact() ? 0 : 1} paddingBottom={compact() ? 0 : 1} gap={compact() ? 0 : 1} flexShrink={0}>
        <text height={1} fg={props.theme.text} wrapMode="none" truncate>
          <span style={{ fg: props.theme.permission }}>{props.mono ? "! " : "△ "}</span>
          {title()}{readFacts(props.request)?.operations.length ? ` · ${readFacts(props.request)!.operations.join("/")}` : ""}
        </text>
        <Show when={!compact() && editing()}>
          <text fg={props.theme.muted}>{stage() === "policy" ? editor().hint : "Tell OpenCode what to do differently"}</text>
        </Show>
        <Show when={state().error}><text fg={props.theme.permission}>{state().error}</text></Show>
        <Show when={stage() === "permission" && unknown()}>
          <text fg={props.theme.permission}>{unknownPolicyTitle}</text>
        </Show>
        <Show when={stage() === "policy" || stage() === "permission"}>
          <For each={policyDirectories(props.request)}>{(directory) => <text fg={props.theme.text}>{directory}</text>}</For>
        </Show>
      </box>
      <Show when={!editing()} fallback={
        <box width="100%" flexGrow={1} minHeight={0} justifyContent="flex-end">
           <box backgroundColor={props.theme.line} paddingLeft={compact() ? 0 : 2} paddingRight={compact() ? 0 : 3}
            flexDirection={width() >= 80 ? "row" : "column"}
            alignItems={width() >= 80 ? "center" : "stretch"} justifyContent="space-between"
            paddingTop={compact() ? 0 : 1} paddingBottom={compact() ? 0 : 1}
            gap={compact() ? 0 : 1} flexShrink={0}>
            <box width={width() >= 80 ? undefined : "100%"} flexGrow={1} flexShrink={1} minWidth={0}>
             <Show when={stage() === "policy"} fallback={
              <RejectField theme={props.theme} text={state().message} disabled={busy()}
                onChange={(text) => controller.setMessage(text)} onConfirm={confirm} onCancel={cancel} />
            }>
               <PolicyField theme={props.theme} editor={editor()} disabled={busy()}
                onChange={(text) => controller.setMessage(text)} onConfirm={confirm} onCancel={cancel} />
             </Show>
            </box>
            <Show when={!busy()} fallback={
              <text fg={props.theme.running} height={1} wrapMode="none" truncate flexShrink={0}>
                {compact() ? "Waiting…" : "Waiting for permission event…"}
              </text>
            }>
               <box flexDirection="row" flexWrap="wrap" columnGap={compact() ? 1 : 2} flexShrink={0}>
                 <Show when={stage() === "policy" && editor().presets.length}><text fg={props.theme.muted}>←/→ select</text></Show>
                <text fg={props.theme.text} height={1} wrapMode="none" flexShrink={0}>
                  enter <span style={{ fg: props.theme.muted }}>{stage() === "policy" ? "apply" : compact() ? "reject" : "confirm"}</span>
                </text>
                <text fg={props.theme.text} height={1} wrapMode="none" flexShrink={0}>
                  esc <span style={{ fg: props.theme.muted }}>{compact() ? "back" : "cancel"}</span>
                </text>
              </box>
            </Show>
          </box>
        </box>
      }>
         {input.children}
         <Show when={opts().includes("Unknown=S")}><text fg={props.theme.muted} flexShrink={0}>{exactSessionHint}</text></Show>
        <box width="100%" flexDirection={inline() ? "row" : "column"} justifyContent="space-between"
          gap={compact() ? 0 : 1} paddingLeft={compact() ? 0 : 2} paddingRight={compact() ? 0 : 3}
          paddingTop={compact() ? 0 : 1} paddingBottom={compact() ? 0 : 1} flexShrink={0} backgroundColor={props.theme.pane}>
          <box width={inline() ? controlsWidth() : "100%"} flexDirection="row" flexWrap="wrap" columnGap={1} flexShrink={0}>
            <For each={opts()}>{(option) => (
              <box width={stringWidth(label(option)) + 2} height={1} flexShrink={0} paddingLeft={1} paddingRight={1}
                backgroundColor={option === state().selected ? props.theme.actionFocusedBg : transparent}
                onMouseMove={() => { if (!busy()) setState((before) => permissionHover(before, option)) }}
                onMouseUp={() => run(option)}>
                <text wrapMode="none" fg={option === state().selected ? props.theme.actionFocusedText : props.theme.actionSecondaryText}
                  attributes={option === state().selected && props.mono ? TextAttributes.INVERSE : undefined}>
                  {label(option)}
                </text>
              </box>
            )}</For>
          </box>
          <text fg={busy() ? props.theme.running : props.theme.text} height={1} wrapMode="none" truncate flexShrink={0}>
            {busy() ? (compact() ? "Waiting…" : "Waiting for permission event…") : hint()}
          </text>
        </box>
      </Show>
    </box>
  }
  return { width, compact, stage, scrollbar, Frame }
}

function PolicyField(props: Omit<FieldProps, "text"> & { editor: ReturnType<typeof policyEditor> }) {
  let input: TextareaRenderable | undefined
  const initialize = createPolicyInput(() => props.editor, () => props.disabled)
  return <textarea width="100%" minHeight={1} maxHeight={3} wrapMode="word"
    placeholder={props.editor.placeholder} placeholderColor={props.theme.muted}
    textColor={props.theme.formfieldText} focusedTextColor={props.theme.formfieldFocusedText}
    backgroundColor={props.theme.surface} focusedBackgroundColor={props.theme.formfieldFocusedBg}
    cursorColor={props.theme.formfieldFocusedText} focused={!props.disabled}
    ref={(value) => { input = value; initialize(value) }}
    onContentChange={() => { if (input && !input.isDestroyed && !props.disabled) props.onChange(input.plainText) }}
    onSubmit={() => { if (!props.disabled) props.onConfirm() }}
    onKeyDown={(event) => {
      if (!props.disabled && event.name === "escape") { event.preventDefault(); props.onCancel() }
    }} />
}
