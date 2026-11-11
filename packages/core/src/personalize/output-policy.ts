import type { LLMEvent } from "@opencode/ai/effect"

export const outputCaps = { default: 16_000, high: 32_000, xhigh: 50_000, max: 100_000 } as const

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {}
}

export function outputEffort(options: unknown, fallback?: string): string {
  const value = record(options)
  const effort = value.reasoningEffort ?? value.reasoning_effort ?? record(value.reasoning).effort ??
    value.effort ?? record(value.outputConfig).effort ?? record(value.output_config).effort ??
    record(value.thinkingConfig).thinkingLevel ?? fallback ?? "default"
  return typeof effort === "string" ? effort.toLowerCase() : "default"
}

export function outputCap(effort: string, ...limits: readonly (number | undefined)[]): number {
  const cap = effort === "max" ? outputCaps.max : effort === "xhigh" ? outputCaps.xhigh :
    effort === "high" ? outputCaps.high : outputCaps.default
  return Math.min(cap, ...limits.filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x > 0).map(Math.floor))
}

// Raw HTTP body overlays are applied AFTER protocol lowering. Do not let an
// existing native override bypass the cap; do not inject foreign provider keys.
export function capBody<T>(body: T, cap: number): T {
  const value = record(body)
  const result = { ...value }
  for (const key of ["max_tokens", "max_completion_tokens", "max_output_tokens", "max_new_tokens", "maxTokens", "maxOutputTokens"]) {
    if (!(key in value)) continue
    const current = value[key]
    result[key] = typeof current === "number" && Number.isFinite(current) && current >= 1
      ? Math.min(cap, Math.floor(current)) : cap
  }
  for (const key of ["generationConfig", "generation_config", "inferenceConfig", "inference_config"]) {
    if (value[key] !== undefined) result[key] = capBody(value[key], cap)
  }
  return result as T
}

// Only local tool calls are held. Text/reasoning remain live, and provider-run
// tools are outside this process's execution control. Never repair partial JSON.
export class OutputGate {
  private calls: LLMEvent[] = []
  private terminal: LLMEvent[] = []
  private finished = false
  rejected: "length" | "invalid" | "incomplete" | undefined

  push(event: LLMEvent): LLMEvent[] {
    if (event.type === "tool-input-error" || event.type === "provider-error") this.rejected ??= "invalid"
    if (event.type === "tool-call" && !event.providerExecuted) {
      this.calls.push(event)
      return []
    }
    if (event.type === "step-finish" || event.type === "finish") {
      this.finished = true
      if (event.reason.normalized === "length") this.rejected = "length"
      else if (event.reason.normalized !== "stop" && event.reason.normalized !== "tool-calls") this.rejected ??= "invalid"
      this.terminal.push(event)
      return []
    }
    return [event]
  }

  end(): LLMEvent[] {
    if (!this.finished) this.rejected ??= "incomplete"
    const events = this.rejected ? this.terminal : [...this.calls, ...this.terminal]
    this.calls = []
    this.terminal = []
    return events
  }
}
