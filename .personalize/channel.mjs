export function normalizeChannel(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(value.trim()) &&
    !["undefined", "null"].includes(value.trim().toLowerCase()) ? value.trim() : "local"
}

// Bun's public define option takes a JavaScript expression. Accept the literal
// forms emitted by the stock builder, never evaluate arbitrary build code.
export function normalizeChannelDefinition(definition) {
  let value
  if (definition === "undefined") value = undefined
  else if (typeof definition === "string" && /^'[^'\\\r\n]*'$/.test(definition)) value = definition.slice(1, -1)
  else {
    try { value = JSON.parse(definition) }
    catch { throw new Error("OPENCODE_CHANNEL build definition must be a literal") }
  }
  return JSON.stringify(normalizeChannel(value))
}
