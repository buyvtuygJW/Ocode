import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Global } from "@opencode-ai/core/global"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { join } from "node:path"
import DESCRIPTION from "./distill.txt"

// Deterministic RSI (Recursive Self-Improvement) distiller — ported as native code.
// Reconstructs the session trajectory from ctx.messages, scores it with a no-LLM
// heuristic (Correctness/Efficiency/Coverage/Reproducibility), and if it scores >= 75
// writes a reusable learned skill under the global opencode config skills dir, where
// opencode auto-discovers it ({skill,skills}/**/SKILL.md) in future sessions.

const THRESHOLD = 75

export const Parameters = Schema.Struct({
  note: Schema.optional(Schema.String),
})

type Metadata = {
  score?: number
  distilled?: boolean
}

// ---- pure helpers ---------------------------------------------------------
function summarize(text: unknown, maxLen: number): string {
  const s = String(text ?? "")
  if (s.length <= maxLen) return s
  return s.slice(0, maxLen - 3) + "..."
}
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)))
}
function slugify(s: unknown): string {
  return (
    String(s ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "skill"
  )
}
function parseResearchState(text: unknown): any {
  const m = String(text ?? "").match(/<rlm_state>([\s\S]*?)<\/rlm_state>/)
  if (!m) return null
  try {
    return JSON.parse(m[1].trim())
  } catch {
    return null
  }
}

// ---- trajectory capture (from ctx.messages) -------------------------------
function capture(messages: any[], sessionID: string, fallbackAgent: string): any {
  if (!messages || !messages.length) return null

  const firstAssistant = messages.find((m) => m && m.info && m.info.role === "assistant")
  const agent = (firstAssistant && firstAssistant.info && firstAssistant.info.agent) || fallbackAgent || "unknown"

  let hypothesis = ""
  for (const msg of messages) {
    if (!msg || !msg.info || msg.info.role !== "assistant") continue
    for (const part of msg.parts || []) {
      if (part && part.type === "text" && typeof part.text === "string") {
        const st = parseResearchState(part.text)
        if (st && st.hypothesis) {
          hypothesis = String(st.hypothesis)
          break
        }
      }
    }
    if (hypothesis) break
  }
  if (!hypothesis) {
    const firstUser = messages.find((m) => m && m.info && m.info.role === "user")
    const tp = firstUser && (firstUser.parts || []).find((p: any) => p && p.type === "text" && !p.synthetic)
    if (tp && typeof tp.text === "string") hypothesis = tp.text.slice(0, 500)
  }

  const steps: any[] = []
  let errorSteps = 0
  for (const msg of messages) {
    if (!msg || !msg.info || msg.info.role !== "assistant") continue
    for (const part of msg.parts || []) {
      if (!part || part.type !== "tool") continue
      const stt = part.state || {}
      if (stt.status === "error") errorSteps++
      const out = stt.status === "completed" ? stt.output || "" : stt.status === "error" ? stt.error || "" : ""
      steps.push({
        tool: part.tool || "unknown",
        inputSummary: summarize(JSON.stringify(stt.input ?? ""), 200),
        outputSummary: summarize(out, 200),
      })
    }
  }

  let outcome = "success"
  let sawState = false
  for (let i = messages.length - 1; i >= 0 && !sawState; i--) {
    const msg = messages[i]
    if (!msg || !msg.info || msg.info.role !== "assistant") continue
    for (const part of msg.parts || []) {
      if (part && part.type === "text" && typeof part.text === "string") {
        const st = parseResearchState(part.text)
        if (st) {
          sawState = true
          const plan = Array.isArray(st.plan) ? st.plan : []
          const hasFailures = plan.some((o: any) => o && o.status === "failed")
          const allDone = plan.length > 0 && plan.every((o: any) => o && (o.status === "done" || o.status === "failed"))
          const allFailed = plan.length > 0 && plan.every((o: any) => o && o.status === "failed")
          if (allFailed) outcome = "failure"
          else if (hasFailures) outcome = "partial"
          else if (st.status === "complete" || allDone) outcome = "success"
          break
        }
      }
    }
  }
  if (!sawState) {
    outcome = steps.length === 0 ? "failure" : errorSteps === 0 ? "success" : errorSteps * 2 >= steps.length ? "failure" : "partial"
  }

  return { sessionId: sessionID, timestamp: Date.now(), agent, hypothesis, steps, outcome, score: 0 }
}

// ---- critic (verbatim no-LLM heuristic) -----------------------------------
function evaluate(t: any): any {
  const base = t.outcome === "success" ? 70 : t.outcome === "partial" ? 45 : 20
  const stepCount = t.steps.length
  const efficiencyMod = stepCount <= 5 ? 10 : stepCount <= 10 ? 5 : stepCount <= 20 ? 0 : stepCount <= 40 ? -5 : -10
  const uniqueTools = new Set(t.steps.map((s: any) => s.tool)).size
  const diversityMod = uniqueTools >= 5 ? 10 : uniqueTools >= 3 ? 5 : uniqueTools >= 2 ? 0 : -5
  const hasHypothesis = String(t.hypothesis || "").length > 20
  const hasReasonableSteps = stepCount >= 3 && stepCount <= 30
  const reproducibilityMod = (hasHypothesis ? 5 : -5) + (hasReasonableSteps ? 5 : -5)
  const total = clamp(base + efficiencyMod + diversityMod + reproducibilityMod, 0, 100)
  return {
    correctness: clamp(Math.round(25 * (t.outcome === "success" ? 1 : t.outcome === "partial" ? 0.6 : 0.2)), 0, 25),
    efficiency: clamp(Math.round(25 * ((efficiencyMod + 10) / 20)), 0, 25),
    coverage: clamp(Math.round(25 * ((diversityMod + 10) / 20)), 0, 25),
    reproducibility: clamp(Math.round(25 * ((reproducibilityMod + 10) / 20)), 0, 25),
    total,
    uniqueTools,
  }
}

// ---- distill + lifecycle (global config skills dir, auto-discovered) -------
function generateSkillContent(name: string, description: string, t: any): string {
  const toolSequence = t.steps.map((s: any, i: number) => `${i + 1}. **${s.tool}**: ${s.inputSummary}`).join("\n")
  const uniqueTools = [...new Set(t.steps.map((s: any) => s.tool))]
  return `---
name: ${name}
description: ${JSON.stringify(description)}
---

# ${name}

## Overview

Automatically distilled from a high-scoring trajectory (score: ${t.score}/100) by the RSI
(Recursive Self-Improvement) loop. It captures a validated workflow pattern.

## Origin

- Agent: ${t.agent}
- Hypothesis: ${t.hypothesis}
- Outcome: ${t.outcome}
- Score: ${t.score}/100
- Steps: ${t.steps.length}
- Distilled: ${new Date(t.timestamp).toISOString()}

## Workflow Pattern

Follow these steps when encountering a similar question:

${toolSequence}

## Tools Used

${uniqueTools.map((x) => `- \`${x}\``).join("\n")}

## When to Use This Skill

Use when the question is similar to:
> ${t.hypothesis}

## Recommendations

- Follow the tool sequence above as a starting template.
- Adapt parameters to your specific data and question.
- Validated for ${t.agent} workflows.
`
}

function registerSkill(learnedRoot: string, name: string, score: number): void {
  const statsPath = join(learnedRoot, ".stats.json")
  let stats: any = { skills: {} }
  try {
    if (existsSync(statsPath)) stats = JSON.parse(readFileSync(statsPath, "utf8"))
  } catch {
    stats = { skills: {} }
  }
  if (!stats.skills) stats.skills = {}
  const now = Date.now()
  if (!stats.skills[name]) stats.skills[name] = { usageCount: 0, firstUsed: 0, lastUsed: 0, created: now, score }
  try {
    writeFileSync(statsPath, JSON.stringify(stats, null, 2), "utf8")
  } catch {
    /* ledger is best-effort */
  }
}

function distill(t: any): { name: string; file: string } {
  const hash = String(t.sessionId || "").slice(-8) || "session"
  const name = `learned-${slugify(t.agent)}-${hash}`
  const learnedRoot = join(Global.Path.config, "skills", "learned")
  const dir = join(learnedRoot, name)
  mkdirSync(dir, { recursive: true })
  const description = `Learned ${String(t.agent).replace("-ultra", "")} workflow: ${String(t.hypothesis).slice(0, 100)}. Uses: ${[...new Set(t.steps.map((s: any) => s.tool))].slice(0, 5).join(", ")}.`
  const file = join(dir, "SKILL.md")
  writeFileSync(file, generateSkillContent(name, description, t), "utf8")
  registerSkill(learnedRoot, name, t.score)
  return { name, file }
}

function runPipeline(messages: any[], sessionID: string, agent: string): { title: string; output: string; score: number; distilled: boolean } {
  const t = capture(messages, sessionID, agent)
  if (!t) return { title: "distill: nothing to do", output: "No messages found in this session; nothing to distill.", score: 0, distilled: false }
  const score = evaluate(t)
  t.score = score.total
  const breakdown = `correctness=${score.correctness}/25 efficiency=${score.efficiency}/25 coverage=${score.coverage}/25 reproducibility=${score.reproducibility}/25`
  const summary = `agent=${t.agent} steps=${t.steps.length} tools=${score.uniqueTools} outcome=${t.outcome}`
  if (score.total < THRESHOLD) {
    return {
      title: `distill: ${score.total}/100 (below ${THRESHOLD}, skipped)`,
      output: `Score ${score.total}/100 (< ${THRESHOLD}) — not distilled.\n${breakdown}\n${summary}`,
      score: score.total,
      distilled: false,
    }
  }
  const saved = distill(t)
  return {
    title: `distill: ${score.total}/100 -> ${saved.name}`,
    output: `Score ${score.total}/100 (>= ${THRESHOLD}) — distilled "${saved.name}".\n${breakdown}\n${summary}\nsaved: ${saved.file}\nopencode auto-discovers it next session via {skill,skills}/**/SKILL.md.`,
    score: score.total,
    distilled: true,
  }
}

// ---- native tool ----------------------------------------------------------
export const DistillTool = Tool.define<typeof Parameters, Metadata, never>(
  "distill_session",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (_args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const r = yield* Effect.sync(() => runPipeline(ctx.messages as any[], String(ctx.sessionID), ctx.agent))
          return {
            title: r.title,
            output: r.output,
            metadata: { score: r.score, distilled: r.distilled },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
