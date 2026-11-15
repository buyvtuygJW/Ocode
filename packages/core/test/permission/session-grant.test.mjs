import { test } from "node:test"
import assert from "node:assert/strict"
import { registerHooks } from "node:module"

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@opencode/schema/permission-shorthand")
      return { url: new URL("../../../schema/src/permission-shorthand.ts", import.meta.url).href, shortCircuit: true }
    if (specifier === "./session-grant.js")
      return { url: new URL("../../src/permission/session-grant.ts", import.meta.url).href, shortCircuit: true }
    return next(specifier, context)
  },
})
const { contains, decision, directories, selections, encode, decode, unknownEffectsDenied } =
  await import("../../src/permission/session-grant.ts")
const request = (operations = ["read"], paths = ["D:/Data/Project/nested/file"], action = "read", access = "content") => ({
  id: "per_test", sessionID: "ses_child", action, operations, paths, resources: paths, access,
})
const grants = (text = "R=S*", directory = "D:/Data/Project") =>
  selections({ scope: "session", policy: text }).map((rule) => ({ ...rule, directory }))

test("Windows subtree boundaries normalize slashes/case and reject traversal and sibling prefixes", () => {
  assert.equal(contains("D:\\Data\\Project", "d:/DATA/project/child/deeper/file"), true)
  for (const target of ["D:/Data/Project-other/file", "D:/Data/Project/../outside/file", "E:/Data/Project/file"])
    assert.equal(contains("D:/Data/Project", target), false)
})
test("approved RU=S* CD=D* matrix enforces reads/updates versus creates/deletes and moves", () => {
  const matrix = grants("RU=S* CD=D*")
  for (const operation of ["read", "update", "create", "delete"])
    assert.equal(decision(matrix, request([operation], undefined, operation === "read" ? "read" : "edit")),
      operation === "read" || operation === "update" ? "allow" : "deny")
  assert.equal(decision(matrix, request(["delete", "create"], undefined, "edit")), "deny")
  assert.equal(decision(matrix, request(["delete", "update"], undefined, "edit")), "deny")
  assert.equal(decision(matrix, request(["read"], ["D:/Data/Project-other/file"])), undefined)
})
test("parent-list reads never cover parent files, sibling contents, grep or recursive glob", () => {
  const parent = grants("R=-S")
  assert.equal(decision(parent, request(["read"], ["D:/Data"], "read", "listing")), "allow")
  for (const input of [
    request(["read"], ["D:/Data/file"]), request(["read"], ["D:/Data/sibling/file"]),
    request(["read"], ["D:/Data/sibling"], "read", "listing"),
    request(["read"], ["D:/Data"], "glob"), request(["read"], ["D:/Data"], "grep"),
  ]) assert.equal(decision(parent, input), undefined)
  assert.equal(grants("R=-1")[0].lifetime, "once")
})
test("compact contradictions and MCP tokens reject before producing any policy", () => {
  for (const text of ["R=S* R=D*", "R=-S*", "U=-S", "", "RU=S* CD=D* MCP=1 council"])
    assert.throws(() => grants(text))
  assert.throws(() => selections({ scope: "session", rules: [
    { operation: "read", effect: "allow", lifetime: "session", recursive: true, scope: "parent-list" },
  ] }))
})
test("recursive searches require subtree coverage and honor nested denials", () => {
  const search = { ...request(["read"], ["D:/Data/Project"], "grep"), metadata: { filesystemReadScope: "recursive" } }
  assert.equal(decision(grants("R=S"), search), undefined)
  assert.equal(decision(grants("R=S*"), search), "allow")
  assert.equal(decision([
    ...grants("R=S*"), ...grants("R=D", "D:/Data/Project/private"),
  ], search), "deny")
  assert.equal(decision(grants("R=S"), request(["read"], ["D:/Data/Project/file.txt"])), "allow")
})
test("structured selections and compact input enforce identical policies", () => {
  const rules = selections({ scope: "session", policy: "RU=S* CD=D*" })
  assert.deepEqual(selections({ scope: "session", rules }), rules)
  assert.equal(selections("once"), undefined)
  assert.equal(selections("always"), undefined)
  assert.equal(grants("R=1")[0].lifetime, "once")
  for (const operation of ["create", "update", "delete"])
    assert.equal(decision(grants("R=S*"), request([operation], undefined, "edit")), undefined)
  assert.equal(decision(grants("R=S*"), { ...request(), operations: undefined }), undefined)
})
test("durable rules survive serialization/recreation, without using project save patterns", () => {
  const before = grants("RU=S* CD=D*")
  const after = decode(JSON.parse(JSON.stringify(before.map(encode))))
  assert.deepEqual(after, before)
  assert.equal(decision(after, request(["update"], undefined, "edit")), "allow")
  const input = { ...request(), action: "external_directory", resources: ["D:/Data/Project/nested/*"], save: ["D:/Data/*"] }
  assert.deepEqual(directories(input), ["D:/Data/Project/nested"])
  assert.equal(directories({ ...input, resources: ["D:/Other/*"] }), undefined)
})
test("shell/MCP unknown local effects fail closed under explicit conversation denies", () => {
  const matrix = grants("RU=S* CD=D*")
  for (const action of ["shell", "mcp.fs.delete"]) {
    const input = { ...request(["read"], undefined, action), metadata: { filesystemEffects: "unknown" } }
    assert.equal(decision(matrix, input), undefined)
    assert.equal(unknownEffectsDenied(matrix, input), true)
    assert.equal(unknownEffectsDenied(grants("R=S*"), input), false)
    assert.equal(unknownEffectsDenied([], input), false)
  }
})
