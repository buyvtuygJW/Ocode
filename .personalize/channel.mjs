export function normalizeChannel(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/i.test(value.trim()) &&
    !["undefined", "null"].includes(value.trim().toLowerCase()) ? value.trim() : "local"
}
