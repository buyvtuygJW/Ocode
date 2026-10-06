/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import path from "path"
import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import { Global } from "../global"
import customizeOpencodeContent from "./skill/customize-opencode.md" with { type: "text" }
import playwrightDepthContent from "./skill/playwright-depth.md" with { type: "text" }

export const CustomizeOpencodeContent = customizeOpencodeContent

// Resolved at import time rather than written into the markdown, so the cache path is
// correct on every platform instead of whichever machine authored the file.
export const PlaywrightDepthCachePath = path.join(Global.Path.state, "playwright-depth-cache.json")
export const PlaywrightDepthContent = playwrightDepthContent.replaceAll("{{CACHE_PATH}}", PlaywrightDepthCachePath)

export const PLAYWRIGHT_DEPTH_DESCRIPTION =
  "Use when taking Playwright or browser MCP snapshots: picks snapshot depth from per-site memory instead of defaulting to full depth."

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-opencode",
            description:
              "Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself.",
            location: AbsolutePath.make("/builtin/customize-opencode.md"),
            content: CustomizeOpencodeContent,
          }),
        }),
      )
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "playwright-depth",
            description: PLAYWRIGHT_DEPTH_DESCRIPTION,
            location: AbsolutePath.make("/builtin/playwright-depth.md"),
            content: PlaywrightDepthContent,
          }),
        }),
      )
    })
  }),
})
