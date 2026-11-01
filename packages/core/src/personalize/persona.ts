import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

export function personaLead(): string {
  const file = process.env.OPENCODE_ROLE_FILE ? resolve(process.env.OPENCODE_ROLE_FILE) : join(process.cwd(), ".opencode", "role.json")
  try {
    mkdirSync(dirname(file), { recursive: true })
    if (!existsSync(file)) {
      writeFileSync(file, JSON.stringify({ usersystem: "", assistant_system: "" }, null, 2) + "\n", "utf8")
      return ""
    }
    const role: unknown = JSON.parse(readFileSync(file, "utf8"))
    return role && typeof role === "object" && "assistant_system" in role && typeof role.assistant_system === "string" ? role.assistant_system : ""
  } catch { return "" }
}

export function stripStockIdentity(prompt: string): string {
  if (prompt.startsWith("You are opencode, an agent")) return prompt
  return prompt.replace(/^You are an AI agent running in OpenCode,[^.]*\.\s*/, "")
    .replace(/^You are (?:OpenCode|opencode),[^.]*\.\s*/, "")
}
