import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { SkillPlugin } from "@opencode-ai/core/plugin/skill"
import { SkillV2 } from "@opencode-ai/core/skill"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(AppNodeBuilder.build(SkillV2.node))

describe("SkillPlugin.Plugin", () => {
  it.effect("registers the built-in customize-opencode skill", () =>
    Effect.gen(function* () {
      const skill = yield* SkillV2.Service
      yield* SkillPlugin.Plugin.effect(host({ skill: { ...skill, reload: skill.reload } }))

      expect(yield* skill.list()).toContainEqual(
        expect.objectContaining({
          name: "customize-opencode",
          description: expect.stringContaining("opencode's own configuration"),
        }),
      )
    }),
  )

  it.effect("registers the built-in playwright-depth skill", () =>
    Effect.gen(function* () {
      const skill = yield* SkillV2.Service
      yield* SkillPlugin.Plugin.effect(host({ skill: { ...skill, reload: skill.reload } }))

      expect(yield* skill.list()).toContainEqual(
        expect.objectContaining({
          name: "playwright-depth",
          description: expect.stringContaining("per-site memory"),
        }),
      )
    }),
  )

  it.effect("resolves the playwright-depth cache path instead of shipping the placeholder", () =>
    Effect.gen(function* () {
      // Guards the real failure mode: a hardcoded authoring-machine path, or a
      // {{CACHE_PATH}} token that never got substituted, silently shipping to users.
      expect(SkillPlugin.PlaywrightDepthContent).not.toContain("{{CACHE_PATH}}")
      expect(SkillPlugin.PlaywrightDepthContent).toContain(SkillPlugin.PlaywrightDepthCachePath)
      expect(SkillPlugin.PlaywrightDepthCachePath).toContain("playwright-depth-cache.json")
    }),
  )
})
