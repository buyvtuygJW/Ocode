import { test } from "node:test"
import assert from "node:assert/strict"
import {
  INITIAL_PERMISSION_REPLY_STATE,
  transitionPermissionReply,
  isPermissionReplied,
  isPermissionResponding,
} from "./permission-machine.ts"

test("a valid parent-list/partial policy does not hide the still-actionable content request", () => {
  const started = transitionPermissionReply(INITIAL_PERMISSION_REPLY_STATE, {
    type: "decide", sessionID: "ses_test", decision: { scope: "session", policy: "R=-S" },
  }).state
  const applied = transitionPermissionReply(started, { type: "reply.succeeded", attempt: started.attempt }).state
  assert.equal(isPermissionReplied(applied), false)
  assert.equal(isPermissionResponding(applied), false)
  const resolved = transitionPermissionReply(applied, { type: "resolved" }).state
  assert.equal(isPermissionReplied(resolved), true)
})

test("invalid policy errors return the prompt to actionable state without losing the exact error", () => {
  const started = transitionPermissionReply(INITIAL_PERMISSION_REPLY_STATE, {
    type: "decide", sessionID: "ses_test", decision: { scope: "session", policy: "R=S* R=D*" },
  }).state
  const error = new Error("Duplicate filesystem operation R")
  const failed = transitionPermissionReply(started, { type: "reply.failed", attempt: started.attempt, error })
  assert.equal(isPermissionResponding(failed.state), false)
  assert.equal(failed.effects.find((effect) => effect.type === "toast-failed").error, error)
})

test("resolution preserves ordinary idle, failed and terminal states while partial policies remain resolvable", () => {
  assert.strictEqual(transitionPermissionReply(INITIAL_PERMISSION_REPLY_STATE, { type: "resolved" }).state,
    INITIAL_PERMISSION_REPLY_STATE)
  const started = transitionPermissionReply(INITIAL_PERMISSION_REPLY_STATE, {
    type: "decide", sessionID: "ses_test", decision: "once",
  }).state
  const failed = transitionPermissionReply(started, {
    type: "reply.failed", attempt: started.attempt, error: "retry explicitly",
  }).state
  assert.strictEqual(transitionPermissionReply(failed, { type: "resolved" }).state, failed)
  const replied = transitionPermissionReply(started, { type: "reply.succeeded", attempt: started.attempt }).state
  assert.strictEqual(transitionPermissionReply(replied, { type: "resolved" }).state, replied)
})
