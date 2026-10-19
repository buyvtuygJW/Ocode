import { Option, Schema } from "effect"

declare const OPENCODE_VERSION: string
declare const OPENCODE_CHANNEL: string
declare const OPENCODE_ARTIFACT: string
declare const OPENCODE_RELEASE_HIGHLIGHTS: string

// A build define can be present but empty (a build from a detached HEAD leaves
// OPENCODE_CHANNEL as ''). `typeof x === "string"` accepts that, so an empty channel used
// to leak downstream and produce things like `opencode-.db`, a bogus `opencode-ai/<empty>`
// npm dist-tag on upgrade, and OPENCODE_LOCAL === false for a local build.
// Guard on content, not just type. `typeof` on an undeclared global is still safe here.
function resolve(value: string | undefined) {
  return value?.trim() ? value.trim() : "local"
}

const version = resolve(typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : undefined)
const channel = resolve(typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : undefined)
const artifact = typeof OPENCODE_ARTIFACT === "string" ? OPENCODE_ARTIFACT : "cli"
// Stable release builds embed the release notes' Highlights; every other build has none.
const highlights =
  typeof OPENCODE_RELEASE_HIGHLIGHTS === "string"
    ? Option.getOrElse(
        Schema.decodeUnknownOption(
          Schema.fromJsonString(Schema.Array(Schema.Struct({ title: Schema.String, body: Schema.String }))),
        )(OPENCODE_RELEASE_HIGHLIGHTS),
        () => [],
      )
    : []

export {
  version as OPENCODE_VERSION,
  channel as OPENCODE_CHANNEL,
  artifact as OPENCODE_ARTIFACT,
  highlights as OPENCODE_HIGHLIGHTS,
}
export const OPENCODE_LOCAL = channel === "local"
