import { expect, test } from "bun:test"
import * as stock from "../src/mini/permission.shared"
import * as policy from "../src/personalize/mini-permission"
import type { MiniPermissionRequest } from "../src/mini/types"
import { withFacts } from "@opencode/schema/personalize/permission-policy"

const request: MiniPermissionRequest = {
  id: "per_policy", sessionID: "ses_policy", action: "shell", resources: ["runner"],
  metadata: { filesystemEffects: "unknown", unknownCommand: "runner", unknownCwd: "C:/work", unknownShell: "powershell.exe" },
}

test("Mini policy adapter reuses pristine presentation and ordinary transitions", () => {
  expect(policy.permissionInfo).toBe(stock.permissionInfo)
  expect(policy.permissionAlwaysLines).toBe(stock.permissionAlwaysLines)
  const initial = policy.createPermissionBodyState(request)
  expect(initial).toEqual(stock.createPermissionBodyState(request))
  for (const choice of ["once", "always", "reject"] as const) {
    const actual = policy.permissionRun(initial, request.id, choice)
    const expected = stock.permissionRun(stock.createPermissionBodyState(request), request.id, choice)
    expect(actual.state).toEqual(expected.state)
    expect(String(actual.reply?.decision)).toBe(String(expected.reply?.decision))
  }
  const always = policy.permissionRun(initial, request.id, "always").state
  expect(policy.permissionRun(always, request.id, "cancel").state.stage).toBe("permission")
  expect(policy.permissionRun(always, request.id, "confirm").reply?.decision).toBe("always")
})

test("Mini unknown choices and command editor never turn navigation into approval", () => {
  const initial = policy.createPermissionBodyState(request)
  const options = policy.permissionOptions("permission", request)
  expect(options).toEqual(["once", "policy", "Unknown=S", "reject"])
  expect(options.map((option) => policy.permissionLabel(option, true))).toEqual(["=1", "Custom", "=S", "=Deny"])
  for (const scope of ["Unknown=S", "Unknown=SE", "Unknown=SEA", "Whole=SEA"] as const) {
    expect(policy.permissionRun(initial, request.id, scope).reply?.decision).toEqual({ scope: "session", policy: scope })
  }
  const opened = policy.permissionRun({ ...initial, message: "old", error: "old" }, request.id, "policy")
  expect(opened.reply).toBeUndefined()
  expect(opened.state).toMatchObject({ stage: "policy", message: "", error: undefined })
  expect(policy.permissionOptions("policy", request)).toEqual([])
  expect(policy.permissionReject({ ...opened.state, message: " Unknown=S " }, request.id)?.decision)
    .toEqual({ scope: "session", policy: "Unknown=S" })
  expect(policy.permissionCancel({ ...opened.state, error: "bad" })).toMatchObject({ stage: "permission", error: undefined })
  expect(policy.permissionRun(initial, request.id, "confirm").reply).toBeUndefined()
  expect(policy.permissionRun(opened.state, request.id, "once").reply).toBeUndefined()
  const busy = { ...opened.state, submitting: true }
  expect(policy.permissionRun(busy, request.id, "policy").state).toBe(busy)
  expect(policy.permissionReject(busy, request.id)).toBeUndefined()
  expect(policy.permissionShift(initial, 1, options).selected).toBe("policy")
  expect(policy.permissionShift(initial, -1, options).selected).toBe("reject")
})

test("Mini filesystem shortcuts remain explicit and preserve request identity", () => {
  const encoded = withFacts({ ...request, action: "read", metadata: {} }, {
    operations: ["read"], paths: ["C:/work/a.ts"], directories: ["C:/work"], access: "content",
  })
  const read: MiniPermissionRequest = { ...encoded, metadata: JSON.parse(JSON.stringify(encoded.metadata)) }
  expect(policy.permissionOptions("permission", read)).toContain("session_read")
  expect(policy.permissionRun(policy.createPermissionBodyState(read), read.id, "session_read").reply).toEqual({
    sessionID: read.sessionID, requestID: read.id, decision: "session_read",
  })
  expect(policy.permissionEscape(policy.createPermissionBodyState(read)).stage).toBe("reject")
})
