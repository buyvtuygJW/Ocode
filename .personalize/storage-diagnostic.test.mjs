import assert from "node:assert/strict"
import { test } from "node:test"
import { storageDiagnostic } from "../packages/util/src/personalize-storage-diagnostic.ts"

test("nested fatal SQL errors retain extended I/O codes without leaking arbitrary error data", () => {
  const sqlite = Object.assign(new Error("sensitive SQL must not be logged"), { name: "SQLiteError", errno: 778, code: "SQLITE_IOERR_WRITE" })
  const cause = { reasons: [{ defect: { reason: { message: "Failed to configure database", cause: sqlite } } }] }
  assert.deepEqual(storageDiagnostic(cause), {
    phase: "configure", sqliteCode: "SQLITE_IOERR_WRITE", sqliteExtendedCode: 778, sqlitePrimaryCode: 10,
  })
  assert.equal(JSON.stringify(storageDiagnostic(cause)).includes("sensitive"), false)
})

test("missing native codes stay unknown, including cyclic causes", () => {
  const cause = { reason: { message: "Failed to open database" } }
  cause.reason.cause = cause
  assert.deepEqual(storageDiagnostic(cause), {
    phase: "open", sqliteCode: undefined, sqliteExtendedCode: undefined, sqlitePrimaryCode: undefined,
  })
  assert.equal(storageDiagnostic({ name: "SQLiteError", errno: -1 }).sqliteExtendedCode, undefined)
  assert.equal(storageDiagnostic({ name: "SQLiteError", errno: "778" }).sqliteExtendedCode, undefined)
})
