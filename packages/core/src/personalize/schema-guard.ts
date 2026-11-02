import { Database as RawDatabase } from "bun:sqlite"
import { getTableColumns } from "drizzle-orm"
import { SessionTable } from "../session/sql"

// Upstream once shipped a migration that drops a column other builds on the
// same machine still select, which turns into "no such column: session_v2.x"
// boot crash loops (2026-10-24: session_v2.allowance). After the stock layer
// settles (migrations included), re-add any column this build's schema
// declares but the table no longer has. Add-only: never drops, never renames,
// no-op when the table is absent. Best effort: any failure is logged and
// skipped so boot never breaks because of the guard itself.
export function guardSessionSchema(file: string | undefined) {
  if (!file || file === ":memory:") return
  let db: RawDatabase
  try {
    db = new RawDatabase(file)
  } catch {
    return
  }
  try {
    const table = db
      .query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'`)
      .get()
    if (!table) return
    const present = new Set(
      db.query<{ name: string }>(`PRAGMA table_info("session_v2")`).all().map((row) => row.name),
    )
    for (const [name, column] of Object.entries(getTableColumns(SessionTable))) {
      if (present.has(name)) continue
      const type = column.getSQLType()
      const literal =
        typeof column.default === "number" || typeof column.default === "string" || typeof column.default === "boolean"
          ? column.default
          : undefined
      const notNull = literal !== undefined && column.notNull ? " NOT NULL" : ""
      const fallback =
        literal === undefined
          ? ""
          : ` DEFAULT ${typeof literal === "string" ? `'${literal.replaceAll("'", "''")}'` : literal}`
      db.run(`ALTER TABLE "session_v2" ADD COLUMN "${name}" ${type}${notNull}${fallback};`)
      console.warn(
        `[personalize schema-guard] session_v2.${name} was missing (dropped by an upstream migration); re-added as ${type}${notNull}${fallback}`,
      )
    }
  } catch (error) {
    console.warn(`[personalize schema-guard] skipped: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    db.close()
  }
}
