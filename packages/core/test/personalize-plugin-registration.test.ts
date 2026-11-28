import { expect, test } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Plugin } from "../src/plugin"
import { Skill } from "../src/skill"
import { PluginHooks } from "../src/plugin/hooks"
import { PersonalizeHooks } from "../src/personalize/hooks"
import { SessionSchema } from "../src/session/schema"
import { Agent } from "../src/agent"
import { Model } from "../src/model"
import { Provider } from "../src/provider"
import { Message, SystemPart } from "@opencode/ai/effect"
import { PersonalizeSkill } from "../src/personalize/skill"
import { registerAfter } from "../src/personalize/plugin-registration"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const entry = (id: string) => ({
  id, revision: "internal", source: { type: "builtin" as const }, effect: () => Effect.void,
})

test("builtin registration preserves stock entries, order, post configuration and input arrays", () => {
  const stock = { pre: [entry("first"), entry("opencode.skill"), entry("last")], post: [entry("config")] }
  const registered = registerAfter(stock, "opencode.skill", PersonalizeSkill.Plugin)
  expect(registered.pre.map((item) => item.id)).toEqual(["first", "opencode.skill", "personalize.playwright-depth", "last"])
  expect(stock.pre.map((item) => item.id)).toEqual(["first", "opencode.skill", "last"])
  expect(registered.pre[0]).toBe(stock.pre[0])
  expect(registered.pre[1]).toBe(stock.pre[1])
  expect(registered.pre[3]).toBe(stock.pre[2])
  expect(registered.post).toBe(stock.post)
})

test("changed, ambiguous and duplicate builtin registrations fail closed", () => {
  const stock = { pre: [entry("opencode.skill")], post: [] }
  expect(() => registerAfter(stock, "missing", PersonalizeSkill.Plugin)).toThrow("Expected one builtin")
  expect(() => registerAfter({ ...stock, pre: [...stock.pre, ...stock.pre] }, "opencode.skill", PersonalizeSkill.Plugin))
    .toThrow("found 2")
  const registered = registerAfter(stock, "opencode.skill", PersonalizeSkill.Plugin)
  expect(() => registerAfter(registered, "opencode.skill", PersonalizeSkill.Plugin)).toThrow("Duplicate builtin")
})

const it = testEffect(PluginTestLayer)
it.effect("Playwright skill registers and unloads through the real plugin host without R or S", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const skills = yield* Skill.Service
    yield* plugins.awaitActivation
    const registry = registerAfter({ pre: [entry("opencode.skill")], post: [] }, "opencode.skill", PersonalizeSkill.Plugin)
    yield* plugins.activate(registry.pre)
    const loaded = yield* skills.get(Skill.ID.make("playwright-depth"))
    expect(loaded?.content).toBe(PersonalizeSkill.PlaywrightDepthContent)
    expect(loaded?.description).toContain("snapshot depth")
    yield* plugins.activate([])
    expect(yield* skills.get(Skill.ID.make("playwright-depth"))).toBeUndefined()
  }),
)

const guarded = testEffect(LayerNode.compile(PersonalizeHooks.decorate(PluginHooks).node))
for (const name of ["context", "compaction", "generate"] as const) {
  guarded.effect(`${name} guards survive malformed output from hooks registered after earlier dispatch`, () =>
    Effect.gen(function* () {
      const hooks = yield* PluginHooks.Service
      const messages = [Message.user("keep this input")]
      const input = () => ({
        sessionID: SessionSchema.ID.create(), agent: Agent.ID.make("test"),
        model: { providerID: Provider.ID.make("test"), id: Model.ID.make("test") },
        system: [SystemPart.make("original instructions")], messages, options: {}, tools: {},
      })
      expect((yield* hooks.trigger("session", name, input())).messages).toEqual(messages)
      yield* hooks.register("session", name, (event) => Effect.sync(() => {
        Reflect.set(event, "system", undefined)
        Reflect.set(event, "messages", undefined)
      }))
      const result = yield* hooks.trigger("session", name, input())
      expect(result.messages).toEqual(messages)
      expect(Array.isArray(result.system)).toBe(true)
      expect(result.system.length).toBe(1)
      const later = yield* hooks.register("session", name, (event) => Effect.sync(() => {
        Reflect.set(event, "messages", [{ role: "assistant", content: null }])
      }))
      const changed = yield* hooks.trigger("session", name, input())
      expect(changed.messages[0].content).toEqual([])
      yield* later.dispose
    }),
  )
}
