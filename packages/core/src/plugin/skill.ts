/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill.js"

import { define, type Context } from "@opencode/plugin/effect/plugin"
import { Document } from "@opencode/schema/config"
import { Effect } from "effect"
import { AbsolutePath } from "../schema.js"
import { Skill } from "../skill.js"
import { Config } from "../config.js"
import { Global } from "@opencode/util/global"
import os from "os"
import path from "path"
import opencodeContent from "./skill/opencode.md" with { type: "text" }
import reportContent from "./skill/report.md" with { type: "text" }
import playwrightDepthContent from "./skill/playwright-depth.md" with { type: "text" }

export const OpencodeContent = opencodeContent
export const ReportContent = reportContent

// Resolved at import time rather than written into the markdown, so the cache path is
// correct on every platform instead of whichever machine authored the file.
export const PlaywrightDepthCachePath = path.join(Global.Path.state, "playwright-depth-cache.json")
export const PlaywrightDepthContent = playwrightDepthContent.replaceAll("{{CACHE_PATH}}", PlaywrightDepthCachePath)

export const PLAYWRIGHT_DEPTH_DESCRIPTION =
  "Use when taking Playwright or browser MCP snapshots: picks snapshot depth from per-site memory instead of defaulting to full depth."

export const OpencodeDescription =
  "Use this skill for any question about OpenCode itself, including how OpenCode works, using or configuring it, migrating from V1 to V2, troubleshooting it, developing plugins or integrations, using the OpenCode SDK, clients, server, or API, and contributing to the OpenCode codebase. Also use it for OpenCode agents, commands, skills, tools, permissions, MCP servers, providers, models, themes, keybinds, formatters, the CLI, TUI, desktop app, and web app."
const REPORT_DESCRIPTION =
  "Use when the user wants to report an opencode issue or bug. Collect standard diagnostics, add user-specific reproduction context, and publish the issue with GitHub CLI."

export const Plugin = define({
  id: "opencode.skill",
  effect: Effect.fn(function* (ctx) {
    const reportContent = yield* reportContentWithDiagnostics(ctx.app)
    yield* ctx.skill.transform((editor) => {
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("opencode"),
          name: Skill.Name.make("OpenCode"),
          description: OpencodeDescription,
          path: AbsolutePath.make("/builtin/opencode.md"),
          content: OpencodeContent,
        }),
      )
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("report"),
          name: Skill.Name.make("Report"),
          description: REPORT_DESCRIPTION,
          path: AbsolutePath.make("/builtin/report.md"),
          content: reportContent,
        }),
      )
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make("playwright-depth"),
          name: Skill.Name.make("Playwright Depth"),
          description: PLAYWRIGHT_DEPTH_DESCRIPTION,
          path: AbsolutePath.make("/builtin/playwright-depth.md"),
          content: PlaywrightDepthContent,
        }),
      )
    })
  }),
})

const reportContentWithDiagnostics = Effect.fn("SkillPlugin.reportContentWithDiagnostics")(function* (
  app: Context["app"],
) {
  const plugins = yield* configuredPlugins()
  // Under emulation on Windows ARM64, os.arch() reads x64 but PROCESSOR_IDENTIFIER still names the ARM host.
  const emulated =
    process.platform === "win32" && os.arch() === "x64" && process.env.PROCESSOR_IDENTIFIER?.startsWith("ARM")
  return [
    ReportContent,
    "",
    "## Runtime Diagnostics Snapshot",
    "",
    "These values were captured when the built-in report skill was registered. Verify them before publishing.",
    "",
    `- opencode version: ${app.version}`,
    `- install/channel: ${app.channel}`,
    `- OS: ${os.type()} ${os.release()} (${os.platform()} ${os.arch()}${emulated ? ", emulated on ARM64" : ""})`,
    `- Terminal: ${terminal()}`,
    `- Shell: ${shell()}`,
    `- Active plugins: ${plugins.length === 0 ? "None found in config" : plugins.join(", ")}`,
  ].join("\n")
})

const configuredPlugins = Effect.fn("SkillPlugin.configuredPlugins")(function* () {
  const config = yield* Config.Service
  return (yield* config.entries())
    .filter((entry): entry is Document => entry.type === "document")
    .flatMap((entry) => entry.info.plugins ?? [])
    .map((entry) => (typeof entry === "string" ? entry : entry.package))
    .toSorted()
})

function terminal() {
  return (
    [
      process.env.TERM_PROGRAM ? `TERM_PROGRAM=${process.env.TERM_PROGRAM}` : undefined,
      process.env.TERM ? `TERM=${process.env.TERM}` : undefined,
      process.env.COLORTERM ? `COLORTERM=${process.env.COLORTERM}` : undefined,
    ]
      .filter((item): item is string => item !== undefined)
      .join(", ") || "Unavailable: terminal environment variables are not set"
  )
}

function shell() {
  return (
    process.env.SHELL ??
    process.env.ComSpec ??
    process.env.COMSPEC ??
    "Unavailable: shell environment variable is not set"
  )
}
