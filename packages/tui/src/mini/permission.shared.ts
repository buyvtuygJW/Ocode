import type { MiniPermissionRequest, PermissionReply } from "./types"
import { parsePermissionShorthand } from "@opencode/schema/permission-shorthand"
import { permissionAlwaysLines, permissionOptionLabel, permissionPresentation } from "../util/permission"
import { toolPath } from "./tool"
import { monoPrefix } from "./mono"

export type PermissionStage = "permission" | "always" | "reject" | "policy"
export type PermissionOption = "once" | "always" | "reject" | "confirm" | "cancel" | "session_read" | "policy"

export type PermissionBodyState = {
  requestID: string
  sessionID: string
  stage: PermissionStage
  selected: PermissionOption
  message: string
  submitting: boolean
  error?: string
}

export type PermissionStep = {
  state: PermissionBodyState
  reply?: PermissionReply
}

export function createPermissionBodyState(
  request: Pick<MiniPermissionRequest, "id" | "sessionID">,
): PermissionBodyState {
  return {
    requestID: request.id,
    sessionID: request.sessionID,
    stage: "permission",
    selected: "once",
    message: "",
    submitting: false,
  }
}

export function permissionOptions(stage: PermissionStage): PermissionOption[] {
  if (stage === "permission") {
    return ["once", "session_read", "policy", "always", "reject"]
  }

  if (stage === "always") {
    return ["confirm", "cancel"]
  }

  return []
}

export function permissionInfo(request: MiniPermissionRequest, directory?: string, mono = false) {
  const state = request.tool?.state
  const info = permissionPresentation(
    {
      action: request.action,
      resources: request.resources,
      metadata: request.metadata,
      input: state?.status === "streaming" ? undefined : state?.input,
      toolMetadata: state?.status === "streaming" ? undefined : state?.metadata,
    },
    (value) => toolPath(value, { home: true, directory }),
  )
  if (!mono) return info
  return {
    ...info,
    icon: monoPrefix(info.icon, true),
    lines: [
      ...(info.diff || info.patch ? [info.diff ?? info.patch!] : []),
      ...info.lines.map((line) => monoPrefix(line, true)),
    ],
    diff: undefined,
    patch: undefined,
  }
}

export function permissionLabel(option: PermissionOption): string {
  if (option === "session_read") return "Read subtree/session"
  if (option === "policy") return "Session CRUD…"
  return permissionOptionLabel(option)
}

export function permissionPolicyError(text: string): string | undefined {
  try {
    const parsed = parsePermissionShorthand(text)
    if (parsed.mcp !== undefined) return "MCP selection belongs to tool configuration, not a directory permission grant."
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export { permissionAlwaysLines }

function permissionReply(
  sessionID: string,
  requestID: string,
  decision: PermissionReply["decision"],
  message?: string,
): PermissionReply {
  return {
    sessionID,
    requestID,
    decision,
    ...(message && message.trim() ? { message: message.trim() } : {}),
  }
}

export function permissionShift(
  state: PermissionBodyState,
  dir: -1 | 1,
  list = permissionOptions(state.stage),
): PermissionBodyState {
  if (list.length === 0) {
    return state
  }

  const idx = Math.max(0, list.indexOf(state.selected))
  const selected = list[(idx + dir + list.length) % list.length]
  return {
    ...state,
    selected,
  }
}

export function permissionHover(state: PermissionBodyState, option: PermissionOption): PermissionBodyState {
  return {
    ...state,
    selected: option,
  }
}

export function permissionRun(state: PermissionBodyState, requestID: string, option: PermissionOption): PermissionStep {
  if (state.submitting) {
    return { state }
  }

  if (state.stage === "permission") {
    if (option === "session_read") return {
      state, reply: permissionReply(state.sessionID, requestID, "session_read"),
    }
    if (option === "policy") return { state: { ...state, stage: "policy", message: "" } }
    if (option === "always") {
      return {
        state: {
          ...state,
          stage: "always",
          selected: "confirm",
        },
      }
    }

    if (option === "reject") {
      return {
        state: {
          ...state,
          stage: "reject",
          selected: "reject",
        },
      }
    }

    return {
      state,
      reply: permissionReply(state.sessionID, requestID, "once"),
    }
  }

  if (state.stage !== "always") {
    return { state }
  }

  if (option === "cancel") {
    return {
      state: {
        ...state,
        stage: "permission",
        selected: "always",
      },
    }
  }

  return {
    state,
    reply: permissionReply(state.sessionID, requestID, "always"),
  }
}

export function permissionReject(state: PermissionBodyState, requestID: string): PermissionReply | undefined {
  if (state.submitting) {
    return undefined
  }

  if (state.stage === "policy") return permissionReply(state.sessionID, requestID, {
    scope: "session", policy: state.message.trim(),
  })
  return permissionReply(state.sessionID, requestID, "reject", state.message)
}

export function permissionCancel(state: PermissionBodyState): PermissionBodyState {
  return {
    ...state,
    stage: "permission",
    selected: "reject",
  }
}

export function permissionEscape(state: PermissionBodyState): PermissionBodyState {
  if (state.stage === "always") {
    return {
      ...state,
      stage: "permission",
      selected: "always",
    }
  }

  return {
    ...state,
    stage: "reject",
    selected: "reject",
  }
}
