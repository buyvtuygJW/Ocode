import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Tool } from "@opencode/schema/tool"
import { isRecord } from "@opencode/util/record"
import { Effect, Schema } from "effect"
import type { Agent } from "../agent.js"
import type { Session } from "../session.js"
import { SessionSchema } from "../session/schema.js"
import type { Interface } from "../tool.js"
import { definition, normalizeContent } from "../tool/runtime.js"

const Input = Schema.Struct({
  agent: Schema.String,
  sessionID: Schema.optionalKey(SessionSchema.ID),
})

const guidance =
  "Effective tools depend on agent configuration and session permissions, not model intelligence. " +
  "Inspect subagent_capabilities or specify required_tools before assigning tester or coordinator roles. " +
  "Visible tools may still require approval; visibility is not authorization."

/** Register after the stock subagent tool, using the same location-scoped services. */
export function registerSubagentCapabilities(
  editor: ToolEditor,
  deps: { agents: Agent.Interface; registry: Interface; sessions: Session.Interface },
): void {
  const inspect = (input: typeof Input.Type, context: Tool.Context) =>
    Effect.gen(function* () {
      // Check ownership before resolving or exposing any child capability information.
      const existing =
        input.sessionID === undefined
          ? undefined
          : yield* deps.sessions.get(input.sessionID).pipe(
              Effect.mapError(
                (error) => new Tool.Error({ message: `Subagent session not found: ${input.sessionID}`, error }),
              ),
            )
      if (existing !== undefined && existing.parentID !== context.sessionID)
        return yield* new Tool.Error({ message: `Session ${existing.id} is not a child of the current session` })
      const agent = yield* deps.agents.resolve(input.agent)
      if (agent === undefined) return yield* new Tool.Error({ message: `Unknown agent: ${input.agent}` })
      if (agent.mode === "primary")
        return yield* new Tool.Error({ message: `Agent ${input.agent} cannot run as a subagent` })
      // New children inherit parent permissions; continuation retains the child's own rules.
      const inherited = existing ?? (yield* deps.sessions.get(context.sessionID).pipe(
        Effect.mapError(
          (error) => new Tool.Error({ message: `Parent session not found: ${context.sessionID}`, error }),
        ),
      ))
      const snapshot = yield* deps.registry.snapshot([...agent.permissions, ...(inherited.permissions ?? [])])
      const tools = Array.from(
        new Set([
          ...snapshot.definitions.map((definition) => definition.name),
          ...Array.from(snapshot.codeModeCatalog?.tools.keys() ?? [], String),
        ]),
      ).sort()
      return {
        verified: true,
        agent: agent.id,
        ...(existing === undefined ? {} : { sessionID: existing.id }),
        tools,
        authorization: "visibility_only",
        approvalMayBeRequired: true,
      }
    })

  const readable = (capabilities: { agent: string; tools: readonly string[] }) =>
    `Verified visible tools for ${capabilities.agent}: ${capabilities.tools.join(", ") || "(none)"}. ` +
    "Visibility is not authorization; tool execution may still require approval."

  editor.add({
    name: "subagent_capabilities",
    options: { codemode: false },
    description: `Inspect a subagent's currently registered, permission-filtered tools without starting it. ${guidance}`,
    input: Input,
    execute: (input, context) =>
      inspect(input, context).pipe(
        Effect.map((capabilities) => ({
          content: readable(capabilities),
          metadata: { subagentCapabilities: capabilities },
        })),
      ),
  })

  editor.update("subagent", (tool) => {
    const execute = tool.execute
    const schema = definition(tool).inputSchema
    // Fail registration rather than accidentally discarding an unfamiliar schema's constraints.
    if (schema.type !== "object" || !isRecord(schema.properties))
      throw new Error("subagent capability preflight requires an object input JSON schema")
    const required = schema.required
    if (required !== undefined && (!Array.isArray(required) || !required.every((key) => typeof key === "string")))
      throw new Error("subagent capability preflight requires string input requirement names")
    tool.input = {
      ...schema,
      properties: {
        ...schema.properties,
        required_tools: {
          type: "array",
          items: { type: "string" },
          description: "Required: tools this assignment needs, e.g. [shell] for execution or [council] for orchestration; [] explicitly declares none. Checked before starting or continuing the child.",
        },
      },
      required: [...new Set([...(required ?? []), "required_tools"])],
    }
    tool.description = `${tool.description}\n\n${guidance} Declare required_tools for every call; use [] only when the assignment needs no tools.`
    tool.execute = (input: unknown, context) =>
      Effect.gen(function* () {
        if (!isRecord(input)) return yield* new Tool.Error({ message: "Expected subagent input object" })
        if (!Object.hasOwn(input, "required_tools"))
          return yield* new Tool.Error({ message: "Declare required_tools before spawning (use [] if none); inspect subagent_capabilities for the selected agent." })
        const { required_tools, ...stock } = input
        if (
          !Array.isArray(required_tools) || !required_tools.every((name: unknown) => typeof name === "string")
        )
          return yield* new Tool.Error({ message: "required_tools must be an array of strings" })
        const selected = yield* Schema.decodeUnknownEffect(Input)(stock).pipe(
          Effect.mapError((error) => new Tool.Error({ message: "Invalid subagent capability input", error })),
        )
        const capabilities = yield* inspect(selected, context)
        const missing = required_tools.filter((name: string) => !capabilities.tools.includes(name))
        if (missing.length > 0)
          return yield* new Tool.Error({
            message:
              `Subagent ${selected.agent} is missing required tools: ${missing.join(", ")}. ` +
              `Available tools: ${capabilities.tools.join(", ") || "(none)"}.`,
            metadata: { subagentCapabilities: capabilities, missingTools: missing },
          })
        const result = yield* execute(stock, context)
        const text = readable(capabilities)
        return {
          ...result,
          metadata: { ...result.metadata, subagentCapabilities: capabilities },
          content: [...normalizeContent(result.content, result.output), { type: "text", text }],
        } satisfies Tool.Result
      })
  })
}
