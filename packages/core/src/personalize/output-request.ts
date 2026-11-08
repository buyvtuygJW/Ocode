import type { LLMRequest } from "@opencode/ai/effect"
import type { Resolved } from "../model-resolver"
import { capBody, outputCap, outputEffort } from "./output-policy"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Same layering the LLM client applies before lowering (route/client.ts
// resolveRequestOptions): model.options sit under the request, later wins,
// records merge by key. The ai package does not export its merge helpers.
function merge(...items: unknown[]): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {}
  for (const item of items) {
    if (!isRecord(item)) continue
    for (const [key, value] of Object.entries(item)) {
      if (value === undefined) continue
      result[key] = isRecord(result[key]) && isRecord(value) ? merge(result[key], value) : value
    }
  }
  return Object.keys(result).length === 0 ? undefined : result
}

// Shared by primary turns, subagents using the same runner, titles and
// compaction. This sets the request's maxTokens, not only catalog metadata.
export function capRequest(request: LLMRequest, model: Resolved, inputTokens?: number): LLMRequest {
  const options = request.model.options
  const providerOptions = merge(options?.providerOptions, request.providerOptions)
  const body = merge(options?.http?.body, request.http?.body)
  const effort = outputEffort(body, outputEffort(providerOptions, model.ref.variant))
  const context = model.limit.context
  const room = context > 0 ? Math.max(1, context - (inputTokens ?? 0) - 1024) : undefined
  const requested = request.maxTokens ?? options?.maxTokens
  const maxTokens = outputCap(effort, requested, model.limit.output, room)
  return {
    ...request,
    // Only lower a limit the request already carries. Stock deliberately omits
    // it for some routes (the ChatGPT/Codex backend rejects any output limit).
    ...(requested === undefined ? {} : { maxTokens }),
    ...(body ? { http: { ...request.http, body: capBody(body, maxTokens) } } : {}),
  }
}
