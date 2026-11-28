import { expect } from "bun:test"
import { Effect } from "effect"
import { Agent } from "../src/agent"
import { Plugin } from "../src/plugin"
import { PersonalizeScience } from "../src/personalize/science"
import { registerAfter } from "../src/personalize/plugin-registration"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)
it.effect("science agents use the real plugin host and preserve later user transforms", () =>
  Effect.gen(function* () {
    const plugins = yield* Plugin.Service
    const agents = yield* Agent.Service
    yield* plugins.awaitActivation
    const registry = registerAfter({
      pre: [{ id: "opencode.agent", revision: "internal", source: { type: "builtin" as const }, effect: () => Effect.void }],
      post: [],
    }, "opencode.agent", PersonalizeScience.Plugin)
    yield* plugins.activate([...registry.pre, {
      id: "test.user-agent-config",
      revision: "1",
      effect: (ctx) => ctx.agent.transform((editor) => editor.update(Agent.ID.make("research"), (agent) => {
        agent.description = "User configured research"
      })).pipe(Effect.asVoid),
    }])
    const expected = ["research", "biology", "physics", "ml", "write", "literature-review", "critique", "physics-critique", "reviewer"]
    for (const id of expected) {
      const agent = yield* agents.get(Agent.ID.make(id))
      expect(agent).toBeDefined()
      expect(agent?.system?.length).toBeGreaterThan(0)
    }
    expect((yield* agents.get(Agent.ID.make("research")))?.description).toBe("User configured research")
    const critique = yield* agents.get(Agent.ID.make("critique"))
    expect(critique?.permissions).toContainEqual({ action: "*", resource: "*", effect: "deny" })
    expect(critique?.permissions.some((rule) => rule.action === "shell" && rule.effect === "allow")).toBe(false)
    yield* plugins.activate([])
    for (const id of expected) expect(yield* agents.get(Agent.ID.make(id))).toBeUndefined()
  }),
)
