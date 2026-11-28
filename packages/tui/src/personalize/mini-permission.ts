import * as stock from "../mini/permission.shared"
import type { MiniPermissionRequest } from "../mini/types"
import { choiceLabel, choices, isCommandScope, type Choice } from "@opencode/schema/personalize/permission-policy"
import type { PermissionDecision } from "@opencode/schema/personalize/permission-controller"

export { permissionAlwaysLines, permissionInfo } from "../mini/permission.shared"
export type PermissionStage = stock.PermissionStage | "policy"
export type PermissionOption = Choice | "confirm" | "cancel"
export type PermissionBodyState = Omit<stock.PermissionBodyState, "stage" | "selected"> & {
  stage: PermissionStage
  selected: PermissionOption
  error?: string
}
export type PermissionReply = {
  sessionID: string
  requestID: string
  decision: PermissionDecision
  message?: string
}
export type PermissionStep = { state: PermissionBodyState; reply?: PermissionReply }

export const createPermissionBodyState = (request: Pick<MiniPermissionRequest, "id" | "sessionID">): PermissionBodyState =>
  stock.createPermissionBodyState(request)
export const permissionOptions = (stage: PermissionStage, request?: MiniPermissionRequest): PermissionOption[] =>
  stage === "policy" ? [] : stage === "permission" && request ? [...choices(request)] : stock.permissionOptions(stage)
export const permissionLabel = (option: PermissionOption, unknown = false) =>
  option === "confirm" || option === "cancel" ? stock.permissionLabel(option) : choiceLabel(option, unknown, stock.permissionLabel)

// Only the custom policy/shortcut branches are owned here. Ordinary stage
// transitions and request presentation keep using the unmodified stock module.
function stockState(state: PermissionBodyState): stock.PermissionBodyState {
  return { ...state, stage: state.stage === "policy" ? "reject" : state.stage,
    selected: state.selected === "policy" || state.selected === "session_read" || isCommandScope(state.selected) ? "once" : state.selected }
}
function stockReply(reply: stock.PermissionStep["reply"]): PermissionReply | undefined {
  if (!reply) return
  if (reply.decision !== "once" && reply.decision !== "always" && reply.decision !== "reject")
    throw new Error("Unsupported stock permission decision")
  return { ...reply, decision: reply.decision, message: reply.message ?? undefined }
}
export function permissionRun(state: PermissionBodyState, requestID: string, option: PermissionOption): PermissionStep {
  if (state.submitting) return { state }
  if (state.stage === "permission" && isCommandScope(option))
    return { state, reply: { sessionID: state.sessionID, requestID, decision: { scope: "session", policy: option } } }
  if (state.stage === "permission" && option === "policy")
    return { state: { ...state, stage: "policy", message: "", error: undefined } }
  if (state.stage === "permission" && option === "session_read")
    return { state, reply: { sessionID: state.sessionID, requestID, decision: option } }
  if (option === "policy" || option === "session_read" || isCommandScope(option) || state.stage === "policy" ||
    (state.stage === "permission" && option !== "once" && option !== "always" && option !== "reject") ||
    (state.stage === "always" && option !== "confirm" && option !== "cancel"))
    return { state }
  const result = stock.permissionRun(stockState(state), requestID, option)
  return { state: result.state, reply: stockReply(result.reply) }
}
export function permissionReject(state: PermissionBodyState, requestID: string): PermissionReply | undefined {
  if (state.submitting) return
  if (state.stage === "policy") return {
    sessionID: state.sessionID, requestID, decision: { scope: "session", policy: state.message.trim() },
  }
  return stockReply(stock.permissionReject(stockState(state), requestID))
}
export const permissionCancel = (state: PermissionBodyState): PermissionBodyState =>
  ({ ...stock.permissionCancel(stockState(state)), error: undefined })
export const permissionEscape = (state: PermissionBodyState): PermissionBodyState =>
  stock.permissionEscape(stockState(state))
export const permissionHover = (state: PermissionBodyState, selected: PermissionOption): PermissionBodyState =>
  ({ ...state, selected })
export function permissionShift(state: PermissionBodyState, dir: -1 | 1, list = permissionOptions(state.stage)): PermissionBodyState {
  if (!list.length) return state
  const index = Math.max(0, list.indexOf(state.selected))
  return { ...state, selected: list[(index + dir + list.length) % list.length] }
}
