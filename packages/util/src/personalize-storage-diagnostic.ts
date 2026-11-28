// Keep structured SQLite codes without serializing SQL, parameters, or the
// arbitrary surrounding cause graph. Effect SqlError wraps the native error.
export function storageDiagnostic(input: unknown) {
  const seen = new Set<object>()
  let phase: "open" | "configure" | "bootstrap" = "bootstrap"
  let native: { name?: string; code?: unknown; errno?: unknown } | undefined
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || seen.has(value)) return
    seen.add(value)
    const record = value as Record<string, unknown>
    if (record.message === "Failed to open database") phase = "open"
    if (record.message === "Failed to configure database") phase = "configure"
    if (record.name === "SQLiteError" || (typeof record.code === "string" && /^SQLITE_[A-Z_]+$/.test(record.code)))
      native = record
    for (const key of ["cause", "reason", "reasons", "error", "defect", "left", "right"]) {
      const item = record[key]
      if (Array.isArray(item)) item.forEach(visit)
      else visit(item)
    }
  }
  visit(input)
  const extended = typeof native?.errno === "number" && Number.isSafeInteger(native.errno) && native.errno >= 0
    ? native.errno : undefined
  return {
    phase,
    sqliteCode: typeof native?.code === "string" && /^SQLITE_[A-Z_]+$/.test(native.code) ? native.code : undefined,
    sqliteExtendedCode: extended,
    sqlitePrimaryCode: extended === undefined ? undefined : extended & 0xff,
  }
}
