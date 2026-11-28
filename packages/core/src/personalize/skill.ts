export * as PersonalizeSkill from "./skill"

import path from "node:path"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import { define } from "@opencode/plugin/effect/plugin"
import { Skill } from "../skill"
import { AbsolutePath } from "../schema"
import { registerAfter } from "./plugin-registration"
import template from "../plugin/skill/playwright-depth.md" with { type: "text" }

export const PlaywrightDepthCachePath = path.join(Global.Path.state, "playwright-depth-cache.json")
export const PlaywrightDepthContent = template.replaceAll("{{CACHE_PATH}}", PlaywrightDepthCachePath)
const description = "Use when taking Playwright or browser MCP snapshots: picks snapshot depth from per-site memory instead of defaulting to full depth."

export const Plugin = define({
  id: "personalize.playwright-depth",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((editor) => editor.add(Skill.Info.make({
      id: Skill.ID.make("playwright-depth"), name: Skill.Name.make("Playwright Depth"), description,
      path: AbsolutePath.make("/builtin/playwright-depth.md"), content: PlaywrightDepthContent,
    })))
  }),
})

export function decorate(stock: typeof import("../plugin/internal")) {
  const list: typeof stock.list = (...args) => stock.list(...args).pipe(
    Effect.map((registry) => registerAfter(registry, "opencode.skill", Plugin)),
  )
  return { list }
}
