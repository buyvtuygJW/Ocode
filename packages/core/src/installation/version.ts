declare global {
  const OPENCODE_VERSION: string
  const OPENCODE_CHANNEL: string
}

// A build define can be present but empty (a build from a detached HEAD leaves
// OPENCODE_CHANNEL as ''). `typeof x === "string"` accepts that, so an empty channel used
// to leak downstream and produce things like `opencode-.db`, a bogus `opencode-ai/<empty>`
// npm dist-tag on upgrade, and InstallationLocal === false for a local build.
// Guard on content, not just type. `typeof` on an undeclared global is still safe here.
function resolve(value: string | undefined) {
  return value?.trim() ? value.trim() : "local"
}

export const InstallationVersion = resolve(typeof OPENCODE_VERSION === "string" ? OPENCODE_VERSION : undefined)
export const InstallationChannel = resolve(typeof OPENCODE_CHANNEL === "string" ? OPENCODE_CHANNEL : undefined)
export const InstallationLocal = InstallationChannel === "local"
