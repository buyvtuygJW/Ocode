import { Schema } from "effect"

export function decorate(stock: typeof import("../config/keybind")) {
  // Definitions are an explicitly exported data table, not an ESM binding rewrite.
  // The original parse/defaultValue functions keep reading this same table.
  Object.assign(stock.Definitions, { "theme.transparent": {
    default: "alt+t", description: "Toggle transparency",
  } })
  Object.assign(stock.Definitions["model.dialog.provider"], { default: "alt+p,ctrl+a" })
  Object.assign(stock.Descriptions, { "theme.transparent": "Toggle transparency" })
  const unknownKeys: typeof stock.unknownKeys = (value) => stock.unknownKeys(value).filter((name) => name !== "theme.transparent")
  const KeybindOverrides = Schema.Struct({ ...stock.KeybindOverrides.fields,
    "theme.transparent": Schema.optional(stock.BindingValueSchema).annotate({ description: "Toggle transparency" }),
  })
  const decode = Schema.decodeUnknownSync(stock.BindingValueSchema)
  const parse: typeof stock.parse = (input) => {
    const { ["theme.transparent"]: toggle, ...rest } = input as typeof input & { "theme.transparent"?: unknown }
    return { ...stock.parse(rest), "theme.transparent": decode(toggle ?? "alt+t") }
  }
  return { Definitions: stock.Definitions, Descriptions: stock.Descriptions, KeybindOverrides, parse, unknownKeys }
}
