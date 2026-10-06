// ============================================================================
// PERSONALIZATION (FinalPersonalizeR) — SINGLE owned file.
// Everything for /distill, /schedule, /council lives HERE: tools, commands,
// tool descriptions, and command templates (inlined as consts — no .txt files).
// RULE: upstream files get AT MOST one import line + one call line:
//   - tool/registry.ts:    import * as CustomTools from "./custom"  ->  ...(yield* CustomTools.builtin)
//   - command/index.ts:    import { customCommands } from "../tool/custom"  ->  Object.assign(commands, customCommands(hints))
// Adding a tool/command changes ONLY this file; upstream hunks never grow.
// ============================================================================
import { Cause, Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Global } from "@opencode-ai/core/global"
import { Provider } from "@/provider/provider"
import { InstanceState } from "@/effect/instance-state"
import { Session } from "@/session/session"
import { MessageID } from "@/session/schema"
import type { TaskPromptOps } from "./task"
import { Agent } from "../agent/agent"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { generateText, type ModelMessage } from "ai"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"

// ---------- inlined tool descriptions + command templates ----------
const DESC_DISTILL = "Deterministically distill CURRENT session into a reusable learned skill using RSI (Recursive Self-Improvement) heuristic — NO LLM scoring. Reconstructs this session's tool trajectory, scores it 0-100 on Correctness/Efficiency/Coverage/Reproducibility, and only if it scores >= 75 writes a reusable skill to global opencode skills dir (~/.config/opencode/skills/learned/<name>/SKILL.md), which opencode auto-discovers in future sessions. Run this at end of a research session. Returns score breakdown and either saved skill path or reason it was skipped.\n"
const DESC_SCHEDULE = "Manage deterministic qm-style background schedules (crons) — plain JSON in global opencode config dir (schedules.json), NO LLM scoring, NO server. Actions: add (name + every: \"<N>m\"|\"<N>h\"|\"<N>d\"|\"daily@HH:MM\" + prompt [+ agent]) upserts a schedule; list shows all with next-run times; remove deletes by name; due lists schedules whose time has come (execute each prompt, then call mark); mark records a completed run by name; export prints crontab/schtasks lines that run `opencode run \"<prompt>\"` so OS scheduler executes them truly unattended. Built-in /schedule command runs everything that is due.\n"
const DESC_COUNCIL = "Convene a multi-model council: fan same question to several models directly (bypasses task tool's single-model limit) and combine their answers by strategy. See `strategy` parameter for seven modes and their aliases.\n\nMembers come from council.json — a per-project \".opencode/council.json\" overrides global config dir. Resolution: inline `members` argument, else per-project file (a blank template is auto-created; entries with an empty \"model\" are skipped), else global file.\n\nIf nothing is configured, tool seeds global council.json with your current model and prints its path. A council needs at least two models; with one, use normal task/subagent flow.\n"
const PROMPT_DISTILL = "Call `distill_session` tool now.\n\nIt deterministically — in code, with NO LLM scoring — reconstructs THIS session's tool\ntrajectory, scores it 0-100 on RSI rubric (Correctness / Efficiency / Coverage /\nReproducibility), and only if it scores >= 75 saves a reusable learned skill under global\nopencode skills dir, which opencode auto-discovers in future sessions.\n\nDo NOT score or reconstruct session yourself. Just invoke `distill_session` and report its\noutput verbatim: score breakdown, and either saved skill path or reason it was not\ndistilled.\n"
const PROMPT_SCHEDULE = "Call `schedule_task` tool now with action=\"due\".\n\nFor EACH schedule it reports as due, in order:\n1. Execute that schedule's prompt as if user had just typed it (delegate to its\n   agent via task tool if one is set).\n2. When it finishes, call `schedule_task` with action=\"mark\" and that schedule's name\n   so run is recorded.\n\nIf nothing is due, call `schedule_task` with action=\"list\" and report when next\nschedule will fire.\n\nSchedules are deterministic qm-style crons — plain JSON, no server:\n- add:    schedule_task action=\"add\" name=\"inbox\" every=\"daily@09:00\" prompt=\"triage my inbox\"\n- remove: schedule_task action=\"remove\" name=\"inbox\"\n- export: schedule_task action=\"export\" prints crontab/schtasks lines so OS runs\n  `opencode run \"<prompt>\"` unattended, without an open session.\n"
const PROMPT_COUNCIL = "Convene a council on this request via `council`.\n\n$ARGUMENTS\n\nPass user's question as `question`. If user named model(s) or an agent count, pass exactly those as `members` (loose names ok — they auto-resolve); models user did not ask for must not be pinged. Omit `members` only when none were named. If a strategy was named (council, compare, debate, moa, router, consensus, arena — aliases ok), pass it; else omit. Do not answer yourself first.\n\nRelay results as-is: synthesized/resolved answer for council/moa/debate; side-by-side for compare/arena (for arena, ask which to keep); winner + scoreboard for consensus; chosen model for router.\n\nIf not configured, print returned file path and tell user to add two or more \"provider/model\" entries — do not invent models.\n"

// ---------- distill_session tool ----------
// Deterministic RSI (Recursive Self-Improvement) distiller — ported as native code.
// Reconstructs session trajectory from ctx.messages, scores it with a no-LLM
// heuristic (Correctness/Efficiency/Coverage/Reproducibility), and if it scores >= 75
// writes a reusable learned skill under global opencode config skills dir, where
// opencode auto-discovers it ({skill,skills}/**/SKILL.md) in future sessions.

const THRESHOLD = 75

export const DistillParams = Schema.Struct({
  note: Schema.optional(Schema.String),
})

type DistillMeta = {
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

Automatically distilled from a high-scoring trajectory (score: ${t.score}/100) by RSI
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

Use when question is similar to:
> ${t.hypothesis}

## Recommendations

- Follow tool sequence above as a starting template.
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
export const DistillTool = Tool.define<typeof DistillParams, DistillMeta, never>(
  "distill_session",
  Effect.gen(function* () {
    return {
      description: DESC_DISTILL,
      parameters: DistillParams,
      execute: (_args: Schema.Schema.Type<typeof DistillParams>, ctx: Tool.Context<DistillMeta>) =>
        Effect.gen(function* () {
          const r = yield* Effect.sync(() => runPipeline(ctx.messages as any[], String(ctx.sessionID), ctx.agent))
          return {
            title: r.title,
            output: r.output,
            metadata: { score: r.score, distilled: r.distilled },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof DistillParams, DistillMeta>
  }),
)

// ---------- schedule_task tool ----------
// Deterministic qm-style background schedules ("crons and watches run work while
// nobody's watching") — ported as native code. NO LLM, NO server, NO Postgres.
// Schedules are plain JSON in global opencode config dir; built-in /schedule
// command executes whatever is due inside a normal session, and `export` emits
// OS-scheduler lines (crontab / schtasks) that run `opencode run "<prompt>"` truly
// unattended, without an open session.

const SCHEDULE_FILE = "schedules.json"

export const ScheduleParams = Schema.Struct({
  action: Schema.Literal("add", "list", "remove", "due", "mark", "export"),
  name: Schema.optional(Schema.String),
  every: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
})

type ScheduleMeta = {
  count?: number
  due?: number
}

// ---- storage ----------------------------------------------------------------
function storePath(): string {
  return join(Global.Path.config, SCHEDULE_FILE)
}
function load(): any[] {
  const p = storePath()
  if (!existsSync(p)) return []
  try {
    const data = JSON.parse(readFileSync(p, "utf8"))
    return Array.isArray(data && data.tasks) ? data.tasks : []
  } catch {
    return []
  }
}
function save(tasks: any[]): void {
  mkdirSync(Global.Path.config, { recursive: true })
  writeFileSync(storePath(), JSON.stringify({ version: 1, tasks }, null, 2), "utf8")
}

// ---- deterministic cadence math ---------------------------------------------
// every: "<N>m" | "<N>h" | "<N>d" (interval) or "daily@HH:MM" (local wall clock)
function intervalMs(every: string): number | null {
  const m = /^(\d+)([mhd])$/.exec(String(every).trim())
  if (!m) return null
  const n = Number(m[1])
  if (!n) return null
  return n * (m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000)
}
function dailyAt(every: string): { hh: number; mm: number } | null {
  const m = /^daily@(\d{1,2}):(\d{2})$/.exec(String(every).trim())
  if (!m) return null
  const hh = Number(m[1])
  const mm = Number(m[2])
  if (hh > 23 || mm > 59) return null
  return { hh, mm }
}
function isDue(t: any, now: number): boolean {
  const iv = intervalMs(t.every)
  if (iv !== null) return t.lastRun == null || now - t.lastRun >= iv
  const d = dailyAt(t.every)
  if (!d) return false
  const fire = new Date(now)
  fire.setHours(d.hh, d.mm, 0, 0)
  const fireAt = fire.getTime()
  return now >= fireAt && (t.lastRun == null || t.lastRun < fireAt)
}
function nextRun(t: any, now: number): number {
  const iv = intervalMs(t.every)
  if (iv !== null) return t.lastRun == null ? now : t.lastRun + iv
  const d = dailyAt(t.every)
  if (!d) return now
  const fire = new Date(now)
  fire.setHours(d.hh, d.mm, 0, 0)
  let fireAt = fire.getTime()
  if (isDue(t, now)) return fireAt
  if (fireAt <= now) fireAt += 86_400_000
  return fireAt
}
function cronExpr(t: any): string {
  const d = dailyAt(t.every)
  if (d) return `${d.mm} ${d.hh} * * *`
  const m = /^(\d+)([mhd])$/.exec(String(t.every).trim())
  if (!m) return "0 * * * *"
  const n = Number(m[1])
  if (m[2] === "m") return `*/${Math.min(n, 59)} * * * *`
  if (m[2] === "h") return `0 */${Math.min(n, 23)} * * *`
  return `0 9 */${Math.min(n, 28)} * *`
}
function fmt(ts: number): string {
  return new Date(ts).toISOString().replace("T", " ").slice(0, 16) + "Z"
}
function dueCount(tasks: any[], now: number): number {
  return tasks.filter((t) => isDue(t, now)).length
}
function describe(t: any, now: number): string {
  const state = isDue(t, now) ? "DUE NOW" : `next ~${fmt(nextRun(t, now))}`
  const runs = `${t.runs || 0} run(s)` + (t.lastRun ? `, last ${fmt(t.lastRun)}` : "")
  const agent = t.agent ? ` — agent=${t.agent}` : ""
  return `- ${t.name} [${t.every}] ${state} — ${runs}${agent}\n  prompt: ${t.prompt}`
}

// ---- actions ------------------------------------------------------------------
function run(args: any): { title: string; output: string; count: number; due: number } {
  const now = Date.now()
  const tasks = load()
  const action = String(args.action || "")
  const name = args.name == null ? "" : String(args.name).trim()

  if (action === "add") {
    const every = String(args.every || "").trim()
    const prompt = String(args.prompt || "").trim()
    if (!name || !every || !prompt) {
      return {
        title: "schedule: add failed",
        output: 'add requires name, every ("<N>m"|"<N>h"|"<N>d"|"daily@HH:MM") and prompt.',
        count: tasks.length,
        due: dueCount(tasks, now),
      }
    }
    if (intervalMs(every) === null && dailyAt(every) === null) {
      return {
        title: "schedule: add failed",
        output: `invalid cadence "${every}" — use "<N>m", "<N>h", "<N>d" or "daily@HH:MM".`,
        count: tasks.length,
        due: dueCount(tasks, now),
      }
    }
    const existing = tasks.find((t) => t.name === name)
    if (existing) {
      existing.every = every
      existing.prompt = prompt
      if (args.agent) existing.agent = String(args.agent)
    } else {
      const entry: any = { name, every, prompt, createdAt: now, lastRun: null, runs: 0 }
      if (args.agent) entry.agent = String(args.agent)
      tasks.push(entry)
    }
    save(tasks)
    return {
      title: `schedule: ${existing ? "updated" : "added"} "${name}"`,
      output:
        `${existing ? "Updated" : "Added"} "${name}" [${every}] -> ${storePath()}\n` +
        `It runs whenever /schedule is invoked while due; use action="export" for unattended OS scheduling.`,
      count: tasks.length,
      due: dueCount(tasks, now),
    }
  }

  if (action === "remove") {
    const idx = tasks.findIndex((t) => t.name === name)
    if (idx < 0) {
      return {
        title: `schedule: "${name}" not found`,
        output: `No schedule named "${name}".`,
        count: tasks.length,
        due: dueCount(tasks, now),
      }
    }
    tasks.splice(idx, 1)
    save(tasks)
    return {
      title: `schedule: removed "${name}"`,
      output: `Removed "${name}". ${tasks.length} schedule(s) remain.`,
      count: tasks.length,
      due: dueCount(tasks, now),
    }
  }

  if (action === "mark") {
    const t = tasks.find((x) => x.name === name)
    if (!t) {
      return {
        title: `schedule: "${name}" not found`,
        output: `No schedule named "${name}".`,
        count: tasks.length,
        due: dueCount(tasks, now),
      }
    }
    t.lastRun = now
    t.runs = (t.runs || 0) + 1
    save(tasks)
    return {
      title: `schedule: marked "${name}"`,
      output: `Recorded run of "${name}" at ${fmt(now)} (${t.runs} total). Next ~${fmt(nextRun(t, now))}.`,
      count: tasks.length,
      due: dueCount(tasks, now),
    }
  }

  if (action === "due") {
    const due = tasks.filter((t) => isDue(t, now))
    if (!due.length) {
      const upcoming = tasks.slice().sort((a, b) => nextRun(a, now) - nextRun(b, now))[0]
      const hint = upcoming
        ? ` Next up: "${upcoming.name}" ~${fmt(nextRun(upcoming, now))}.`
        : ' No schedules exist — add one with action="add".'
      return { title: "schedule: nothing due", output: `Nothing is due.${hint}`, count: tasks.length, due: 0 }
    }
    const lines = due.map((t, i) => `${i + 1}. name=${t.name}${t.agent ? ` agent=${t.agent}` : ""}\n   prompt: ${t.prompt}`)
    return {
      title: `schedule: ${due.length} due`,
      output:
        `${due.length} schedule(s) are due. Execute each prompt below in order, then call this tool with action="mark" and its name:\n` +
        lines.join("\n"),
      count: tasks.length,
      due: due.length,
    }
  }

  if (action === "export") {
    if (!tasks.length) {
      return { title: "schedule: nothing to export", output: "No schedules exist.", count: 0, due: 0 }
    }
    const cron = tasks.map(
      (t) => `${cronExpr(t)} opencode run ${t.agent ? `--agent ${t.agent} ` : ""}${JSON.stringify(t.prompt)}`,
    )
    const win = tasks.map(
      (t) =>
        `schtasks /Create /F /TN "opencode-${t.name}" /SC DAILY /ST 09:00 /TR "opencode run ${t.agent ? `--agent ${t.agent} ` : ""}'${String(t.prompt).replace(/"/g, "'")}'"`,
    )
    return {
      title: `schedule: exported ${tasks.length}`,
      output:
        "For truly unattended runs (no open session), register these with OS scheduler.\n" +
        "crontab (crontab -e):\n" +
        cron.join("\n") +
        "\nWindows (adjust /SC and /ST to cadence):\n" +
        win.join("\n"),
      count: tasks.length,
      due: dueCount(tasks, now),
    }
  }

  // list (default)
  if (!tasks.length) {
    return {
      title: "schedule: empty",
      output: `No schedules. Add one: action="add" name="inbox" every="daily@09:00" prompt="...". Stored at ${storePath()}.`,
      count: 0,
      due: 0,
    }
  }
  const due = dueCount(tasks, now)
  return {
    title: `schedule: ${tasks.length} task(s), ${due} due`,
    output: tasks.map((t) => describe(t, now)).join("\n") + `\nstore: ${storePath()}`,
    count: tasks.length,
    due,
  }
}

// ---- native tool ----------------------------------------------------------
export const ScheduleTool = Tool.define<typeof ScheduleParams, ScheduleMeta, never>(
  "schedule_task",
  Effect.gen(function* () {
    return {
      description: DESC_SCHEDULE,
      parameters: ScheduleParams,
      execute: (args: Schema.Schema.Type<typeof ScheduleParams>, _ctx: Tool.Context<ScheduleMeta>) =>
        Effect.gen(function* () {
          const r = yield* Effect.sync(() => run(args as any))
          return {
            title: r.title,
            output: r.output,
            metadata: { count: r.count, due: r.due },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof ScheduleParams, ScheduleMeta>
  }),
)

// ---------- council tool ----------
// Multi-model council: fan same question to N models directly (one provider call per
// member, so it is not bound to task tool's single parent model) and combine answers
// by strategy. Deterministic orchestration; model calls are only non-determinism.
// Members are plain council.json — a per-project ".opencode/council.json" overrides global.

const COUNCIL_FILE = "council.json"

// original open-swarm name + aiscouncil alias -> canonical (both trigger same setup)
const ALIASES: Record<string, string> = {
  fusion: "council",
  council: "council",
  orchestrator: "router",
  "smart-router": "router",
  smart_router: "router",
  router: "router",
  map: "moa",
  moa: "moa",
  mixture: "moa",
  debate: "debate",
  roundtable: "debate",
  consensus: "consensus",
  vote: "consensus",
  "consensus-vote": "consensus",
  consensus_vote: "consensus",
  compare: "compare",
  arena: "arena",
}
const CANONICAL = ["council", "compare", "debate", "moa", "router", "consensus", "arena"]
function normStrategy(s: string): string {
  const k = String(s || "").trim().toLowerCase()
  return ALIASES[k] ?? (CANONICAL.includes(k) ? k : "council")
}

export const CouncilParams = Schema.Struct({
  strategy: Schema.optional(Schema.String).annotate({
    description:
      "Deliberation strategy (canonical name or alias — both trigger same setup):\n" +
      "- council (alias: fusion): every member answers, then chairman synthesizes one definitive answer.\n" +
      "- compare: every member answers, shown side by side, no synthesis.\n" +
      "- debate (alias: roundtable): members argue over `rounds`, then chairman resolves it; debaters can read files named in the question.\n" +
      "- moa (alias: map): members propose, chairman aggregates them (Mixture-of-Agents).\n" +
      "- router (aliases: orchestrator, smart-router): chairman routes to single best member, which answers.\n" +
      "- consensus (alias: vote): members answer, then score each other; highest total wins (chairman breaks ties).\n" +
      "- arena: members answer side by side and user picks winner.\n" +
      "Omit to use configured default strategy.",
  }),
  question: Schema.optional(Schema.String).annotate({
    description:
      "Question council deliberates on. Omit to print resolved configuration and member roster instead of convening.",
  }),
  rounds: Schema.optional(Schema.Number).annotate({
    description: "Number of debate rounds (debate strategy only); clamped to 1-4, default 2.",
  }),
  members: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      'Inline override of council members for this call: an array of "provider/model" strings, e.g. ' +
      '["anthropic/claude-opus-4-8","openai/gpt-5","google/gemini-2.5-pro"]. When omitted, members are read from ' +
      '.opencode/council.json (per-project) or global council.json.',
  }),
})

type CouncilMeta = {
  strategy?: string
  members?: number
  winner?: string
}

type Member = { name: string; model: string }
type Ans = { name: string; model: string; text: string }
type CouncilConfig = {
  selection?: string // manual | intelligence | speed | cost (v1: manual is authoritative; profiles are advisory)
  members?: Member[]
  chairman?: string
  defaultStrategy?: string
  rounds?: number
}

const MEMBER_SYSTEM =
  "You are one member of an expert council. Answer question directly, thoroughly and honestly. Do not mention council."
const CHAIR_SYSTEM =
  "You are chairman of an expert council. Judge and combine members' answers rigorously and without bias."
// blank per-project stub: empty "model" => that entry is skipped, so a bare project file falls through to global
const TEMPLATE: CouncilConfig = {
  selection: "manual",
  members: [
    { name: "model-a", model: "" },
    { name: "model-b", model: "" },
  ],
  chairman: "",
  defaultStrategy: "council",
  rounds: 2,
}

// ---- pure helpers ---------------------------------------------------------
function readConfig(file: string): CouncilConfig | null {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}
function writeConfig(file: string, cfg: CouncilConfig): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(cfg, null, 2), "utf8")
}
function validMembers(cfg: CouncilConfig | null): Member[] {
  if (!cfg || !Array.isArray(cfg.members)) return []
  return cfg.members
    .filter((m) => m && typeof m.model === "string" && m.model.trim().length > 0)
    .map((m, i) => ({ name: String(m.name || `model${i + 1}`), model: m.model.trim() }))
}
// ---- catalog automap ------------------------------------------------------
// Provider registry is already in memory (same list model picker uses), so
// snapping a loosely-typed name -> a real "provider/model" is free: no network, no tokens,
// no extra round-trip. A member written as "nemotron" or "qwen3.8" resolves to whatever
// this machine actually has instead of failing with "not configured".
type Catalog = Record<string, { models: Record<string, unknown> }>
const normId = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9.]+/g, "")
function catalogIds(provs: Catalog): string[] {
  const out: string[] = []
  for (const [pid, info] of Object.entries(provs ?? {}))
    for (const mid of Object.keys(info?.models ?? {})) out.push(`${pid}/${mid}`)
  return out
}
// Score "pid/mid" against a loose query; -1 means no match. Shorter ids win ties so
// "qwen3.8" prefers qwen3.8-max over qwen3.8-flash-thinking-preview.
function scoreId(id: string, q: string): number {
  const mid = id.split("/").slice(1).join("/")
  const nq = normId(q)
  const nid = normId(id)
  const nmid = normId(mid)
  if (!nq) return -1
  // Version guard: every number written in query must exist in candidate.
  // This is what stops "fable99999" from silently becoming "claude-fable-5", or
  // "opus-9" from becoming "opus-5". A wrong version is a different model.
  const qNums = String(q).toLowerCase().match(/\d+(?:\.\d+)?/g) ?? []
  if (qNums.length) {
    const idNums = new Set(id.toLowerCase().match(/\d+(?:\.\d+)?/g) ?? [])
    if (qNums.some((x) => !idNums.has(x))) return -1
  }
  // Tiers are 100 apart and length is only a TIE-BREAKER inside a tier — subtracting
  // raw length used to push a tier clean through one below it (a substring hit scored
  // 600 - len < 600, i.e. under AUTOMAP_MIN), which silently made that whole tier dead and
  // rejected honest names like "fable" and "haiku-4-5".
  const tie = Math.min(nmid.length, 99) / 100
  if (nid === nq) return 1000
  if (nmid === nq) return 900
  if (nmid.startsWith(nq)) return 800 - tie
  if (nid.includes(nq) || nmid.includes(nq)) return 700 - tie
  const toks = String(q).toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean)
  if (toks.length && toks.every((t) => nid.includes(normId(t)))) return 600 - tie
  return -1
}
// Only confident hits (exact / prefix / substring) are ever applied. Weaker matches are
// reported as suggestions so user and model can see them and choose — never
// substituted behind their back.
// = substring tier's floor (tie-breaker is always < 1), so "substring or better".
// All-tokens tier (600) deliberately falls below this and stays suggestion-only.
const AUTOMAP_MIN = 700 - 1
function rankIds(provs: Catalog, q: string): { id: string; score: number }[] {
  const out: { id: string; score: number }[] = []
  for (const id of catalogIds(provs)) {
    let s = scoreId(id, q)
    if (s < 0) continue
    if (id.endsWith("-free")) s += 25 // same model, no bill — wins ties
    out.push({ id, score: s })
  }
  return out.sort((a, b) => b.score - a.score)
}
// Registry is a catalog, not a liveness check: getModel() happily resolves an id
// provider has since retired (e.g. opencode/nemotron-3-super-free), so validation passes and
// model only dies at generate time. Liveness cannot be known without spending a call, so
// instead of guessing we keep ranked siblings ready and fail over to them on a real error.
function familyOf(id: string): string {
  const [pid, ...rest] = id.split("/")
  return `${pid}/${rest.join("/").split(/[-.]/)[0]}`
}
function altIds(provs: Catalog, id: string, n: number): string[] {
  const fam = familyOf(id)
  return catalogIds(provs)
    .filter((c) => c !== id && familyOf(c) === fam)
    .sort((a, b) => Number(b.endsWith("-free")) - Number(a.endsWith("-free")) || a.localeCompare(b))
    .slice(0, n)
}
// Build a roster straight from registry, then drop stale generations: a variant
// (gpt-*-pro, gpt-*-luna, ...) keeps only its newest version, and anything a whole
// major generation behind series' newest is dropped too — unless it is a cheap
// workhorse tier (nano/mini/lite/flash/haiku), which stays (newest version of it).
// Nothing invented or hardcoded: all keys are derived from ids themselves.
const CHEAP_TIER = /nano|mini|lite|flash|haiku/
// Catalog lists everything provider sells, not what this key can chat with.
// Non-text endpoints (realtime/audio/image/embeddings/...) 404 on text generate.
const NON_CHAT = /realtime|audio|tts|whisper|transcri|embed|image|dall-?e|sora|moderation|computer-use|search-preview|rerank|vision-only/
function verOf(mid: string): number[] {
  return (mid.match(/\d+(?:\.\d+)?/g) ?? []).map(Number)
}
function verCmp(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? -1) - (b[i] ?? -1)
    if (d) return d
  }
  return 0
}
function latestOnly(ids: string[], keep: Set<string>): string[] {
  // variant key: id with version numbers stripped ("openai/gpt-5.4-pro" -> "openai/gpt-pro")
  const vkey = (id: string) => id.toLowerCase().replace(/\d+(?:\.\d+)?/g, "").replace(/[-._ ]+/g, "-")
  // series key: everything before first digit ("openai/gpt-", "anthropic/claude-haiku-")
  const skey = (id: string) => id.toLowerCase().split(/\d/)[0]
  const best = new Map<string, string>() // variant -> newest id
  const gen = new Map<string, number>() // series -> newest major
  for (const id of ids) {
    const v = verOf(id.split("/").slice(1).join("/"))
    if (!v.length) continue // unversioned ids are never pruned
    const k = vkey(id)
    const prev = best.get(k)
    if (!prev || verCmp(v, verOf(prev.split("/").slice(1).join("/"))) > 0) best.set(k, id)
    const s = skey(id)
    gen.set(s, Math.max(gen.get(s) ?? -1, Math.floor(v[0])))
  }
  return ids.filter((id) => {
    if (keep.has(id)) return true
    const v = verOf(id.split("/").slice(1).join("/"))
    if (!v.length) return true
    if (best.get(vkey(id)) !== id) return false // older version of same variant
    if (Math.floor(v[0]) < (gen.get(skey(id)) ?? 0) && !CHEAP_TIER.test(vkey(id))) return false
    return true
  })
}
function autoMembers(provs: Catalog, cur: string): Member[] {
  const picked: Member[] = []
  const seen = new Set<string>()
  if (cur) {
    picked.push({ name: "current", model: cur })
    seen.add(cur)
  }
  const chatIds = catalogIds(provs).filter((id) => !NON_CHAT.test(id.toLowerCase()))
  for (const id of latestOnly(chatIds, seen).sort((a, b) => a.localeCompare(b))) {
    if (seen.has(id)) continue
    seen.add(id)
    picked.push({ name: `member${picked.length + 1}`, model: id })
  }
  return picked
}
function block(answers: Ans[]): string {
  return answers.map((a, i) => `### [${i + 1}] ${a.model}\n${a.text}`).join("\n\n")
}
// Chairman-facing rendering: numbered and anonymous. Never includes member names
// or model IDs, so judge weighs content instead of brand.
function blindBlock(answers: Ans[]): string {
  return answers.map((a, i) => `### [${i + 1}]\n${a.text}`).join("\n\n")
}
function clampIndex(text: string, n: number): number {
  const m = String(text ?? "").match(/\d+/)
  let idx = m ? parseInt(m[0], 10) - 1 : 0
  if (!Number.isFinite(idx) || idx < 0) idx = 0
  if (idx >= n) idx = n - 1
  return idx
}
function argmax(arr: number[]): number {
  let best = 0
  for (let i = 1; i < arr.length; i++) if (arr[i] > arr[best]) best = i
  return best
}
// parse a strict-evaluator reply like {"1": 8, "2": 5} into a 0-indexed score array (or null)
function parseScores(text: string, n: number): number[] | null {
  const m = String(text ?? "").match(/\{[\s\S]*\}/)
  if (!m) return null
  let obj: any
  try {
    obj = JSON.parse(m[0])
  } catch {
    return null
  }
  if (!obj || typeof obj !== "object") return null
  const out = new Array(n).fill(0)
  let any = false
  for (let i = 0; i < n; i++) {
    const num = Number(obj[String(i + 1)] ?? obj[i + 1])
    if (Number.isFinite(num)) {
      out[i] = num
      any = true
    }
  }
  return any ? out : null
}

// ---- native tool ----------------------------------------------------------
export const CouncilTool = Tool.define(
  "council",
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    const sessions = yield* Session.Service
    const agents = yield* Agent.Service

    // one-shot model call (mirrors Agent.generate); may fail into error channel
    const askDirect = Effect.fn("CouncilTool.askDirect")(function* (model: string, system: string, user: string, temperature: number) {
      const pm = Provider.parseModel(model)
      const resolved = yield* provider.getModel(pm.providerID, pm.modelID)
      const language = yield* provider.getLanguage(resolved)
      const messages: ModelMessage[] = [
        { role: "system", content: system },
        { role: "user", content: user },
      ]
      const text = yield* Effect.tryPromise({
        try: () => generateText({ temperature, messages, model: language, providerOptions: { openai: { store: false } } }).then((r) => r.text),
        catch: (e) => new Error(String(e)),
      })
      return String(text ?? "").trim()
    })

    // Same call, but routed through a real child session — exact path a TUI subagent
    // takes. Origin-restricted models (opencode free tier: "can only be used from
    // within opencode TUI") refuse a raw SDK request yet accept session traffic.
    // Members normally answer one-shot. With readFiles (debate) the child session
    // is read-only: `read` allowed, every other tool denied, parent's
    // external_directory rules kept so machine-local paths stay reachable.
    const askViaSession = Effect.fn("CouncilTool.askViaSession")(function* (
      ctx: Tool.Context,
      label: string,
      model: string,
      system: string,
      user: string,
      readFiles?: boolean,
    ) {
      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (!ops) return yield* Effect.fail(new Error("no session transport in this context"))
      const pm = Provider.parseModel(model)
      // Mirror TaskTool: resolve a real subagent and derive child permission from
      // parent session. Old blanket deny made this a *primary* agent with
      // everything refused, which is what free-tier gating keys off.
      const subagent = yield* agents.get("general")
      if (!subagent) return yield* Effect.fail(new Error("council: no 'general' subagent available"))
      const parent = yield* sessions.get(ctx.sessionID)
      const child = yield* sessions.create({
        parentID: ctx.sessionID,
        title: `council: ${label} (${model})`,
        agent: subagent.name,
        permission: readFiles
          ? [
              { permission: "*", pattern: "*", action: "deny" as const },
              ...(parent.permission ?? []).filter((r) => r.permission === "external_directory"),
              { permission: "read", pattern: "*", action: "allow" as const },
            ]
          : deriveSubagentSessionPermission({
              parentSessionPermission: parent.permission ?? [],
              subagent,
            }),
      })
      const result = yield* ops.prompt({
        messageID: MessageID.ascending(),
        sessionID: child.id,
        model: { providerID: pm.providerID, modelID: pm.modelID },
        agent: subagent.name,
        system,
        parts: yield* ops.resolvePromptParts(user),
      })
      if (result.info.role === "assistant" && result.info.error) {
        const message =
          "message" in result.info.error.data && typeof result.info.error.data.message === "string"
            ? result.info.error.data.message
            : result.info.error.name
        return yield* Effect.fail(new Error(message))
      }
      const text = (result.parts.findLast((p) => p.type === "text")?.text ?? "").trim()
      if (!text) return yield* Effect.fail(new Error("empty response"))
      return text
    })

    // Direct first — it is cheap and carries no agent preamble. Only when provider
    // rejects it do we pay for session route, so paid models behave exactly as before
    // and free-tier models stop being dead weight in council.
    // readFiles must take the session route: tools only exist there.
    const ask = (ctx: Tool.Context, label: string, model: string, system: string, user: string, temperature: number, readFiles?: boolean) =>
      readFiles && ctx.extra?.promptOps
        ? askViaSession(ctx, label, model, system, user, true)
        : askDirect(model, system, user, temperature).pipe(
        Effect.catchCause((direct) =>
          ctx.extra?.promptOps
            ? askViaSession(ctx, label, model, system, user).pipe(
                Effect.catchCause((session) =>
                  Effect.fail(
                    new Error(`${String(Cause.squash(session))} (direct: ${String(Cause.squash(direct))})`),
                  ),
                ),
              )
            : Effect.failCause(direct),
        ),
      )

    // never-failing member answer — a failure becomes a visible marker instead of killing council
    // A retired-but-catalogued model fails here, not at validation. Rather than returning a
    // dead member as a "[failed]" marker that silently shrinks council, walk ranked
    // siblings once each. Swap is reported in answer's model label, never hidden.
    const askSafe: (
      ctx: Tool.Context,
      m: Member,
      system: string,
      user: string,
      temperature: number,
      alts?: string[],
      readFiles?: boolean,
    ) => Effect.Effect<Ans> = (ctx, m, system, user, temperature, alts = [], readFiles) =>
      ask(ctx, m.name, m.model, system, user, temperature, readFiles).pipe(
        Effect.map((text): Ans => ({ name: m.name, model: m.model, text })),
        Effect.catchCause((cause) =>
          alts.length
            ? askSafe(ctx, { name: m.name, model: alts[0] }, system, user, temperature, alts.slice(1), readFiles).pipe(
                Effect.map((a): Ans => (a.text.startsWith("[failed:") ? a : { ...a, model: `${a.model} (fell back from ${m.model})` })),
              )
            : Effect.succeed({ name: m.name, model: m.model, text: `[failed: ${String(Cause.squash(cause)).slice(0, 100)}]` }),
        ),
      )

    const run = Effect.fn("CouncilTool.execute")(function* (args: Schema.Schema.Type<typeof CouncilParams>, ctx: Tool.Context) {
      const globalFile = join(Global.Path.config, COUNCIL_FILE)
      const projectDir = yield* InstanceState.directory.pipe(Effect.catchCause(() => Effect.succeed("")))
      const projectFile = projectDir ? join(projectDir, ".opencode", COUNCIL_FILE) : ""

      // per-project blank template (fast skip marker) — created once if missing
      if (projectFile && !existsSync(projectFile)) {
        try {
          writeConfig(projectFile, TEMPLATE)
        } catch {}
      }

      const projectCfg = projectFile ? readConfig(projectFile) : null
      const globalCfg = readConfig(globalFile)

      // resolution: inline arg > per-project > global
      let members: Member[]
      let source: string
      if (args.members && args.members.length) {
        members = args.members.map((s, i) => ({ name: `model${i + 1}`, model: String(s).trim() })).filter((m) => m.model)
        source = "inline"
      } else if (validMembers(projectCfg).length) {
        members = validMembers(projectCfg)
        source = projectFile
      } else {
        members = validMembers(globalCfg)
        source = globalFile
      }

      const warnings: string[] = []
      const cur = yield* provider.defaultModel().pipe(
        Effect.map((m) => `${m.providerID}/${m.modelID}`),
        Effect.catchCause(() => Effect.succeed("")),
      )
      const provs = yield* provider.list().pipe(Effect.catchCause(() => Effect.succeed({} as Catalog)))

      // nothing configured -> build a real council from registry instead of bailing.
      // Everything needed is already in memory, so this costs nothing and runs immediately.
      if (members.length === 0) {
        const auto = autoMembers(provs, cur)
        if (auto.length >= 2) {
          const cfg: CouncilConfig = {
            selection: "manual",
            members: auto,
            chairman: cur || auto[0].model,
            defaultStrategy: "council",
            rounds: 2,
          }
          let wrote = ""
          try {
            writeConfig(globalFile, cfg)
            wrote = globalFile
          } catch {}
          members = auto
          source = wrote || "auto-built (in memory; config not writable)"
          warnings.push(
            `no council configured — auto-built from your models:\n${auto
              .map((m) => `  - ${m.name}: ${m.model}`)
              .join("\n")}${wrote ? `\nSaved: ${wrote}` : ""}`,
          )
        } else {
          const out = [
            "No council is configured, and fewer than two models are available to build one from.",
            `  ${globalFile}`,
            projectFile ? `Blank per-project override:\n  ${projectFile}` : "",
            cur ? `Only reachable model: ${cur}` : "No providers are configured — set up API keys first.",
            `Add two or more "provider/model" entries and a "chairman", then run /council again.`,
          ]
            .filter(Boolean)
            .join("\n")
          return { title: "council: not configured", output: out, metadata: { members: 0 } as CouncilMeta }
        }
      }

      const strategy = normStrategy(args.strategy || projectCfg?.defaultStrategy || globalCfg?.defaultStrategy || "council")

      // validate members against live provider registry (same lookup ask() uses at runtime).
      // Invalid entries are backfilled with CURRENT session model — provably working, it is
      // answering right now — never dropped silently. Fewer than 2 distinct survivors -> fail loud
      // with a pick-list of models user actually has configured.
      {
        const checked: Member[] = []
        const bad: string[] = []
        const mapped: string[] = []
        for (const m of members) {
          const pm = Provider.parseModel(m.model)
          let hint = ""
          const ok = yield* provider.getModel(pm.providerID, pm.modelID).pipe(
            Effect.map(() => true),
            Effect.catchCause((cause) => {
              const sq = Cause.squash(cause) as { suggestions?: string[] }
              if (Array.isArray(sq?.suggestions) && sq.suggestions.length)
                hint = ` (did you mean: ${sq.suggestions.slice(0, 3).join(", ")}?)`
              return Effect.succeed(false)
            }),
          )
          if (ok) {
            checked.push(m)
            continue
          }
          // automap: snap loose name onto nearest model this machine really has,
          // but only on a confident hit. Anything weaker is surfaced, not applied.
          const ranked = rankIds(provs, m.model)
          const top = ranked[0]
          if (top && top.score >= AUTOMAP_MIN && top.id !== m.model) {
            const hp = Provider.parseModel(top.id)
            const ok2 = yield* provider.getModel(hp.providerID, hp.modelID).pipe(
              Effect.map(() => true),
              Effect.catchCause(() => Effect.succeed(false)),
            )
            if (ok2) {
              mapped.push(`  - ${m.name}: ${m.model} -> ${top.id}`)
              checked.push({ name: m.name, model: top.id })
              continue
            }
          }
          const near = ranked.slice(0, 3).map((r) => r.id)
          bad.push(
            `  - ${m.name}: ${m.model}${hint}${
              near.length ? ` — nearest: ${near.join(", ")} (NOT applied, too different; name it exactly)` : ""
            }`,
          )
        }
        if (mapped.length)
          warnings.push(
            `AUTOMAPPED ${mapped.length} — these names did not exist, snapped to nearest model. DOUBLE CHECK:\n${mapped.join("\n")}`,
          )
        if (bad.length) {
          if (cur && !checked.some((c) => c.model === cur)) {
            checked.push({ name: "current", model: cur })
            warnings.push(`${bad.length} invalid member(s) in ${source} — backfilled with current model (${cur}):\n${bad.join("\n")}`)
          } else {
            warnings.push(
              `${bad.length} invalid member(s) in ${source} dropped (current model ${cur ? `${cur} already a member` : "unavailable"}):\n${bad.join("\n")}`,
            )
          }
        }
        members = checked
        const need = strategy === "router" ? 1 : 2
        if (members.length < need) {
          // provs = provider.list() = connected providers only (opencode's own usable-model registry)
          return {
            title: "council: pick models",
            output: [
              `Only ${members.length} valid member(s); ${need} needed. Usable models on this machine:`,
              catalogIds(provs).map((id) => `  - ${id}`).join("\n") || "  (none — no provider connected)",
              `Pick ${need}+ from this list and set them in ${source === "inline" ? globalFile : source}, then re-run.`,
            ].join("\n"),
            metadata: { members: members.length } as CouncilMeta,
          }
        }
      }

      let chairman = String(projectCfg?.chairman || globalCfg?.chairman || members[0].model).trim() || members[0].model
      {
        const pc = Provider.parseModel(chairman)
        const ok = yield* provider.getModel(pc.providerID, pc.modelID).pipe(
          Effect.map(() => true),
          Effect.catchCause(() => Effect.succeed(false)),
        )
        if (!ok) {
          warnings.push(`chairman "${chairman}" is not a valid model — using ${members[0].model} instead.`)
          chairman = members[0].model
        }
      }
      const warn = warnings.length ? warnings.map((w) => `⚠ council: ${w}`).join("\n") + "\n\n" : ""
      const rounds = Math.max(1, Math.min(4, Number(args.rounds || projectCfg?.rounds || globalCfg?.rounds || 2)))
      const question = String(args.question || "").trim()

      const askChair = (system: string, user: string, temperature: number, fallback: string) =>
        ask(ctx, "chairman", chairman, system, user, temperature).pipe(
          Effect.catchCause(() => Effect.succeed(fallback)),
        )

      // no question -> status/list
      if (!question) {
        return {
          title: `council: ready (${members.length} members)`,
          output: warn + [
            `Configured (${members.length} members, source: ${source}).`,
            members.map((m) => `  - ${m.name}: ${m.model}`).join("\n"),
            `chairman: ${chairman}   default strategy: ${strategy}`,
            `strategies: ${CANONICAL.join(", ")} (aliases: fusion=council, orchestrator/smart-router=router, map=moa, roundtable=debate, vote=consensus)`,
            `Call again with a question to convene.`,
          ].join("\n"),
          metadata: { strategy, members: members.length } as CouncilMeta,
        }
      }

      if (members.length === 1 && strategy !== "router") {
        return {
          title: "council: only 1 model",
          output: warn + `Only one model is configured (${members[0].model}); a council needs two or more. Edit ${source}, or use normal task/subagent flow.`,
          metadata: { strategy, members: 1 } as CouncilMeta,
        }
      }

      // shared answer pass for strategies that need every member's answer
      let answers: Ans[] = []
      if (["council", "compare", "moa", "consensus", "arena"].includes(strategy)) {
        answers = yield* Effect.all(
          members.map((m) => askSafe(ctx, m, MEMBER_SYSTEM, question, 0.7, altIds(provs, m.model, 2))),
          { concurrency: 4 },
        )
      }

      let output = ""
      let title = `council: ${strategy}`
      let winner: string | undefined

      if (strategy === "compare") {
        output = `## Compare — ${members.length} models, no synthesis\n\n${block(answers)}`
      } else if (strategy === "arena") {
        output = `## Arena — you pick winner\n\n${block(answers)}\n\nTell me which number you prefer and I'll treat it as final answer.`
      } else if (strategy === "council") {
        const final = yield* askChair(
          CHAIR_SYSTEM,
          `Question:\n${question}\n\nCouncil answers:\n\n${block(answers)}\n\nSynthesize one definitive answer: integrate strongest points, resolve contradictions, correct errors. Output final answer only.`,
          0.2,
          `[chairman synthesis unavailable]\n\n${block(answers)}`,
        )
        output = `## Council synthesis\n\n${final}\n\n---\n### Member answers\n\n${block(answers)}`
        title = `council: synthesized ${members.length} answers`
      } else if (strategy === "moa") {
        // Aggregator sees anonymous, unordered proposals - content over authorship.
        const final = yield* askChair(
          "You are aggregator in a Mixture-of-Agents pipeline. Proposals are anonymous and unordered; judge them purely on merit and never speculate about who wrote which.",
          `Question:\n${question}\n\nProposed answers:\n\n${blindBlock(answers)}\n\nAggregate them into one higher-quality answer, keeping best of each. Output aggregated answer only.`,
          0.3,
          `[aggregation unavailable]\n\n${block(answers)}`,
        )
        output = `## Mixture-of-Agents\n\n${final}\n\n---\n### Proposers\n\n${block(answers)}`
      } else if (strategy === "router") {
        const roster = members.map((m, i) => `[${i + 1}] ${m.name} (${m.model})`).join("\n")
        const picked = yield* askChair(
          "You are a routing controller that selects single best model for a task.",
          `Question:\n${question}\n\nModels:\n${roster}\n\nReply with ONLY number of best model.`,
          0,
          "1",
        )
        const idx = clampIndex(picked, members.length)
        const ans = yield* askSafe(ctx, members[idx], MEMBER_SYSTEM, question, 0.4)
        winner = members[idx].name
        output = `## Smart Router\nRouted to [${idx + 1}] ${members[idx].name} (${members[idx].model}).\n\n${ans.text}`
        title = `council: routed to ${members[idx].name}`
      } else if (strategy === "consensus") {
        const listing = answers.map((a, i) => `[${i + 1}]\n${a.text}`).join("\n\n")
        const scorePrompt =
          `Question:\n${question}\n\nCandidates:\n\n${listing}\n\n` +
          `Score EACH candidate 1-10 for correctness and quality. Reply ONLY with JSON like {"1": 8, "2": 5} covering all ${answers.length}.`
        const runs = yield* Effect.all(
          members.map((m) =>
            ask(ctx, m.name + " (scoring)", m.model, "You are a strict evaluator.", scorePrompt, 0).pipe(
              Effect.catchCause(() => Effect.succeed("")),
            ),
          ),
          { concurrency: 4 },
        )
        const totals = new Array(answers.length).fill(0)
        let scored = 0
        for (const r of runs) {
          const p = parseScores(r, answers.length)
          if (p) {
            p.forEach((v, i) => (totals[i] += v))
            scored++
          }
        }
        let idx: number
        if (scored > 0) idx = argmax(totals)
        else {
          const pick = yield* askChair(
            CHAIR_SYSTEM,
            `Question:\n${question}\n\nCandidates:\n\n${listing}\n\nReply with ONLY number of best answer.`,
            0,
            "1",
          )
          idx = clampIndex(pick, answers.length)
        }
        winner = answers[idx].name
        const scoreboard = answers
          .map((a, i) => `[${i + 1}] ${a.name} (${a.model}) — ${scored ? totals[i] + " pts" : "n/a"}`)
          .join("\n")
        output = `## Consensus vote\nWinner: [${idx + 1}] ${answers[idx].name}\n\n${answers[idx].text}\n\n---\n### Scoreboard\n${scoreboard}\n\n---\n### All answers\n\n${block(answers)}`
        title = `council: consensus -> ${answers[idx].name}`
      } else {
        // debate — members get read-only file access so user can hand both sides a file
        const debater =
          "You are a debater on an expert panel. If the question references file paths, read them with the `read` tool before arguing."
        const transcript: { label: string; text: string }[] = []
        let current = yield* Effect.all(
          members.map((m) =>
            askSafe(ctx, m, debater, `Question:\n${question}\n\nGive your opening position.`, 0.7, [], true),
          ),
          { concurrency: 4 },
        )
        current.forEach((a) => transcript.push({ label: `${a.name} (r1)`, text: a.text }))
        for (let r = 2; r <= rounds; r++) {
          const prev = current
          current = yield* Effect.all(
            members.map((m, i) =>
              askSafe(
                ctx,
                m,
                debater,
                `Question:\n${question}\n\nOther members said:\n${prev
                  .filter((_, j) => j !== i)
                  .map((o) => `- ${o.name}: ${o.text}`)
                  .join("\n\n")}\n\nRebut, defend or refine your position (round ${r}).`,
                0.6,
                [],
                true,
              ),
            ),
            { concurrency: 4 },
          )
          current.forEach((a) => transcript.push({ label: `${a.name} (r${r})`, text: a.text }))
        }
        const final = yield* askChair(
          "You are moderator resolving a debate.",
          `Question:\n${question}\n\nTranscript:\n\n${transcript
            .map((t) => `### ${t.label}\n${t.text}`)
            .join("\n\n")}\n\nResolve debate into single best-supported answer.`,
          0.2,
          "[moderator resolution unavailable]",
        )
        output = `## Debate — ${rounds} round(s)\n\n### Resolution\n${final}\n\n---\n### Transcript\n\n${transcript
          .map((t) => `#### ${t.label}\n${t.text}`)
          .join("\n\n")}`
        title = `council: debate resolved`
      }

      return { title, output: warn + output, metadata: { strategy, members: members.length, ...(winner ? { winner } : {}) } as CouncilMeta }
    })

    return {
      description: DESC_COUNCIL,
      parameters: CouncilParams,
      execute: (args: Schema.Schema.Type<typeof CouncilParams>, ctx: Tool.Context) => run(args, ctx).pipe(Effect.orDie),
    }
  }),
)

// ---------- registry hook payload (tools) ----------
// Personalization tools compiled into binary (distill / schedule / council).
// Isolated in ONE owned file so upstream registry.ts patch stays a fixed
// 2-line delta -- adding a tool changes only this file, never registry hunk.
export const builtin = Effect.gen(function* () {
  const distilltool = yield* DistillTool
  const scheduletool = yield* ScheduleTool
  const counciltool = yield* CouncilTool
  return yield* Effect.all([Tool.init(distilltool), Tool.init(scheduletool), Tool.init(counciltool)])
})

// ---------- command hook payload (/distill /schedule /council) ----------
// Personalization commands (/distill, /schedule, /council). Isolated in ONE
// owned file so upstream command/index.ts patch stays a fixed 2-line delta;
// adding a command changes only this list, never index.ts hunk.
// ONE-LINE call site in index.ts: `Object.assign(commands, customCommands(hints))`.
// Loop + object shape live HERE (owned file) so upstream hunk is a single line
// that upstream edits can never half-break.
export function customCommands(hints: (template: string) => string[]) {
  const out: Record<
    string,
    { name: string; description: string; source: "command"; template: string; hints: string[] }
  > = {}
  for (const c of CUSTOM_COMMANDS)
    out[c.name] = {
      name: c.name,
      description: c.description,
      source: "command",
      template: c.template,
      hints: hints(c.template),
    }
  return out
}

export const CUSTOM_COMMANDS: { name: string; description: string; template: string }[] = [
  {
    name: "distill",
    description: "distill this session into a reusable skill (RSI, deterministic)",
    template: PROMPT_DISTILL,
  },
  {
    name: "schedule",
    description: "run qm-style background schedules that are due (deterministic crons)",
    template: PROMPT_SCHEDULE,
  },
  {
    name: "council",
    description: "convene a multi-model council (council/compare/debate/moa/router/consensus/arena)",
    template: PROMPT_COUNCIL,
  },
]
