import { Option, Schema } from "effect"
import { For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { parsePermissionShorthand } from "@opencode/schema/permission-shorthand"
import type { Permission } from "@opencode/schema/permission"
import { Button } from "@opencode/ui/button"
import { DockPrompt } from "@opencode/session-ui/dock-prompt"
import { Icon } from "@opencode/ui/icon"
import { useLanguage } from "@/runtime/i18n/language"

const decodeToolInput = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))

const isString = Schema.is(Schema.String)

export function SessionPermissionDock(props: {
  request: Permission.Request
  responding: boolean
  onDecide: (response: Permission.Reply) => void
}) {
  const language = useLanguage()
  const [policy, setPolicy] = createStore({ text: "", error: "" })
  const applyPolicy = () => {
    try {
      const parsed = parsePermissionShorthand(policy.text)
      if (parsed.mcp !== undefined) {
        setPolicy("error", language.t("permission.policy.mcpSeparate"))
        return
      }
      setPolicy("error", "")
      props.onDecide({ scope: "session", policy: policy.text })
    } catch (error) {
      setPolicy("error", error instanceof Error ? error.message : String(error))
    }
  }

  const toolDescription = () => {
    const key = `settings.permissions.tool.${props.request.action}.description`
    // SAFETY: an action without a curated description returns the key itself, which the check below detects.
    const value = language.t(key as Parameters<typeof language.t>[0])

    if (value === key) return ""

    return value
  }

  const input = () =>
    Option.match(decodeToolInput(props.request.metadata?.input), {
      onNone: () => [],
      onSome: (value) =>
        Object.entries(value).map(([key, item]) => `${key}: ${isString(item) ? item : JSON.stringify(item)}`),
    })

  return (
    <DockPrompt
      kind="permission"
      header={
        <div data-slot="permission-row" data-variant="header">
          <span data-slot="permission-icon">
            <Icon name="warning" size="normal" />
          </span>
          <div data-slot="permission-header-title">{language.t("notification.permission.title")}</div>
        </div>
      }
      footer={
        <>
          <div />
          <div data-slot="permission-footer-actions">
            <Button variant="ghost" size="normal" onClick={() => props.onDecide("reject")} disabled={props.responding}>
              {language.t("ui.permission.deny")}
            </Button>
            <Button
              variant="neutral"
              size="normal"
              onClick={() => props.onDecide("always")}
              disabled={props.responding}
            >
              {language.t("ui.permission.allowAlways")}
            </Button>
            <Button variant="submit" size="normal" onClick={() => props.onDecide("once")} disabled={props.responding}>
              {language.t("ui.permission.allowOnce")}
            </Button>
          </div>
        </>
      }
    >
      <div data-slot="permission-row">
        <span data-slot="permission-spacer" aria-hidden="true" />
        <Show when={toolDescription()} fallback={<code data-slot="permission-action">{props.request.action}</code>}>
          <div data-slot="permission-hint">{toolDescription()}</div>
        </Show>
      </div>

      <Show when={(props.request.directories?.length || props.request.action === "external_directory") && props.request.operations?.length}>
        <label data-slot="permission-policy">
          <span>{language.t("permission.policy.label")}</span>
          <For each={props.request.directories ?? props.request.resources.map((resource) => resource.replace(/\/\*$/, ""))}>
            {(directory) => <code>{directory}</code>}
          </For>
          <input
            value={policy.text}
            placeholder={language.t("permission.policy.placeholder")}
            disabled={props.responding}
            onInput={(event) => setPolicy("text", event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === "Enter") applyPolicy() }}
          />
          <span>{language.t("permission.policy.scope")}</span>
          <Show when={policy.error}><span role="alert">{policy.error}</span></Show>
        </label>
        <Button variant="neutral" disabled={props.responding} onClick={applyPolicy}>
          {language.t("permission.policy.apply")}
        </Button>
      </Show>
      <Show when={props.request.message}>
        {(message) => (
          <div data-slot="permission-row">
            <span data-slot="permission-spacer" aria-hidden="true" />
            <div data-slot="permission-hint">{message()}</div>
          </div>
        )}
      </Show>

      <Show when={input().length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          {/* Scrolls rather than truncates: the user approves these arguments, so all of them must be reachable */}
          <div data-slot="permission-input" data-scrollable>
            <For each={input()}>{(line) => <code class="text-text-weak break-all">{line}</code>}</For>
          </div>
        </div>
      </Show>

      <Show when={props.request.resources.length > 0}>
        <div data-slot="permission-row">
          <span data-slot="permission-spacer" aria-hidden="true" />
          <div data-slot="permission-patterns">
            <For each={props.request.resources}>
              {(pattern) => <code class="text-text-base break-all">{pattern}</code>}
            </For>
          </div>
        </div>
      </Show>
    </DockPrompt>
  )
}
