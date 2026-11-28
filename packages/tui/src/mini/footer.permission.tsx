// Permission UI body for the direct-mode footer.
//
// Renders inside the footer when the reducer pushes a FooterView of type
// "permission". Uses a three-stage state machine (permission.shared.ts):
//
//   permission → shows the request with Allow once / Always / Reject buttons
//   always     → confirmation step before granting permanent access
//   reject     → text field for the rejection message
//
// Keyboard: left/right to select, enter to confirm, esc to reject.
// The diff view (when available) uses the same diff component as scrollback
// tool snapshots.
/** @jsxImportSource @opentui/solid */
import { measureEditText, type ScrollBoxRenderable, type TextareaRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { For, Match, Show, Switch, createEffect, createMemo } from "solid-js"
import { permissionAlwaysLines, permissionInfo } from "./permission.shared"
import { createMiniPermissionView } from "../personalize/mini-permission-controls"
import type { PermissionReply } from "../personalize/mini-permission"
import { toolFiletype } from "./tool"
import type { RunBlockTheme, RunFooterTheme } from "./theme"
import type { MiniPermissionRequest } from "./types"
import { PatchDiff } from "../component/patch-diff"

/** @internal Exported to test managed textarea submission without permission navigation. */
export function RejectField(props: {
  theme: RunFooterTheme
  text: string
  disabled: boolean
  onChange: (text: string) => void
  onConfirm: () => void
  onCancel: () => void
}) {
  const renderer = useRenderer()
  let area: TextareaRenderable | undefined

  createEffect(() => {
    if (!area || area.isDestroyed) {
      return
    }

    if (area.plainText !== props.text) {
      area.setText(props.text)
      area.cursorOffset = measureEditText(props.text, { widthMethod: renderer.widthMethod })
    }

    queueMicrotask(() => {
      if (!area || area.isDestroyed || props.disabled) {
        return
      }
      area.focus()
    })
  })

  return (
    <textarea
      width="100%"
      minHeight={1}
      maxHeight={3}
      wrapMode="word"
      placeholder="Tell OpenCode what to do differently"
      placeholderColor={props.theme.muted}
      textColor={props.theme.formfieldText}
      focusedTextColor={props.theme.formfieldFocusedText}
      backgroundColor={props.theme.surface}
      focusedBackgroundColor={props.theme.formfieldFocusedBg}
      cursorColor={props.theme.formfieldFocusedText}
      focused={!props.disabled}
      onSubmit={props.onConfirm}
      onContentChange={() => {
        if (!area || area.isDestroyed) {
          return
        }
        props.onChange(area.plainText)
      }}
      onKeyDown={(event) => {
        if (event.name === "escape") {
          event.preventDefault()
          props.onCancel()
          return
        }
      }}
      ref={(item) => {
        area = item
      }}
    />
  )
}

export function RunPermissionBody(props: {
  request: MiniPermissionRequest
  directory?: () => string
  theme: RunFooterTheme
  block: RunBlockTheme
  onReply: (input: PermissionReply) => void | Promise<void>
  mono?: boolean
}) {
  let scroll: ScrollBoxRenderable | undefined
  const view = createMiniPermissionView(props, () => scroll, RejectField)
  const { width, compact, stage, scrollbar } = view
  const info = createMemo(() => permissionInfo(props.request, props.directory?.(), props.mono))
  const ft = createMemo(() => toolFiletype(info().file))
  return (
    <view.Frame>
        <box
          width="100%"
          flexGrow={1}
          minHeight={0}
          paddingLeft={compact() ? 0 : 1}
          paddingRight={compact() ? 0 : 3}
          paddingBottom={compact() ? 0 : 1}
        >
          <scrollbox
            width="100%"
            flexGrow={1}
            minHeight={0}
            viewportOptions={{
              paddingLeft: compact() ? 0 : 1,
              paddingRight: props.mono ? 0 : 1,
            }}
            verticalScrollbarOptions={scrollbar()}
            ref={(item) => {
              scroll = item
            }}
          >
            <Switch>
              <Match when={stage() === "permission"}>
                <box width="100%" flexDirection="column" flexShrink={0} gap={compact() ? 0 : 1}>
                  <box width="100%" paddingLeft={compact() ? 0 : 1} flexShrink={0}>
                    <text width="100%" fg={props.theme.text} wrapMode="word" flexShrink={0}>
                      <span style={{ fg: props.theme.muted }}>{info().icon} </span>
                      {info().title}
                    </text>
                  </box>
                  <Show
                    when={info().diff}
                    fallback={
                      <Show
                        when={info().patch}
                        fallback={
                          <box width="100%" flexDirection="column" flexShrink={0} gap={compact() ? 0 : 1}>
                            <For each={info().lines}>
                              {(line) => (
                                <text width="100%" fg={props.theme.text} wrapMode="word" flexShrink={0}>
                                  {line}
                                </text>
                              )}
                            </For>
                          </box>
                        }
                      >
                        {(patch) => (
                          <Show
                            when={props.block.syntax}
                            fallback={
                              <text width="100%" fg={props.theme.muted} wrapMode="word" flexShrink={0}>
                                {patch()}
                              </text>
                            }
                          >
                            {(syntax) => (
                              <code
                                width="100%"
                                flexShrink={0}
                                wrapMode="word"
                                filetype="diff"
                                drawUnstyledText={false}
                                streaming={true}
                                syntaxStyle={syntax()}
                                content={patch()}
                                fg={props.theme.muted}
                              />
                            )}
                          </Show>
                        )}
                      </Show>
                    }
                  >
                    <Show
                      when={width() >= 40}
                      fallback={
                        <text width="100%" fg={props.theme.text} wrapMode="word" flexShrink={0}>
                          {info().diff}
                        </text>
                      }
                    >
                      <PatchDiff
                        diff={info().diff!}
                        hunkFg={props.block.diffLineNumber}
                        view="unified"
                        filetype={ft()}
                        syntaxStyle={props.block.syntax}
                        showLineNumbers={true}
                        width="100%"
                        flexShrink={0}
                        wrapMode="word"
                        fg={props.theme.text}
                        addedBg={props.block.diffAddedBg}
                        removedBg={props.block.diffRemovedBg}
                        contextBg={props.block.diffContextBg}
                        addedSignColor={props.block.diffHighlightAdded}
                        removedSignColor={props.block.diffHighlightRemoved}
                        lineNumberFg={props.block.diffLineNumber}
                        lineNumberBg={props.block.diffContextBg}
                        addedLineNumberBg={props.block.diffAddedLineNumberBg}
                        removedLineNumberBg={props.block.diffRemovedLineNumberBg}
                      />
                    </Show>
                  </Show>
                  <Show when={!info().diff && !info().patch && info().lines.length === 0}>
                    <text width="100%" fg={props.theme.muted} flexShrink={0}>
                      No diff provided
                    </text>
                  </Show>
                </box>
              </Match>
              <Match when={true}>
                <box width="100%" flexDirection="column" flexShrink={0} gap={compact() ? 0 : 1}>
                  <For each={permissionAlwaysLines(props.request)}>
                    {(line) => (
                      <text width="100%" fg={props.theme.text} wrapMode="word" flexShrink={0}>
                        {line}
                      </text>
                    )}
                  </For>
                </box>
              </Match>
            </Switch>
          </scrollbox>
        </box>
    </view.Frame>
  )
}
