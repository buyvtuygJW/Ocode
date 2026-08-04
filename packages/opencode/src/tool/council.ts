import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Global } from "@opencode-ai/core/global"
import { Provider } from "@/provider/provider"
import { InstanceState } from "@/effect/instance-state"
import { generateText, type ModelMessage } from "ai"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, dirname } from "node:path"
import DESCRIPTION from "./council.txt"

// Multi-model council: fan the same question to N models directly (one provider call per
// member, so it is not bound to the task tool's single parent model) and combine the answers
// by strategy. Deterministic orchestration; the model calls are the only non-determinism.
// Members are plain council.json — a per-project ".opencode/council.json" overrides the global.

const FILE = "council.json"

// original open-swarm name + aiscouncil alias -> canonical (both trigger the same setup)
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

export const Parameters = Schema.Struct({
  strategy: Schema.optional(Schema.String).annotate({
    description:
      "Deliberation strategy (canonical name or alias — both trigger the same setup):\n" +
      "- council (alias: fusion): every member answers, then the chairman synthesizes one definitive answer.\n" +
      "- compare: every member answers, shown side by side, no synthesis.\n" +
      "- debate (alias: roundtable): members argue over `rounds`, then the chairman resolves it.\n" +
      "- moa (alias: map): members propose, the chairman aggregates them (Mixture-of-Agents).\n" +
      "- router (aliases: orchestrator, smart-router): the chairman routes to the single best member, which answers.\n" +
      "- consensus (alias: vote): members answer, then score each other; highest total wins (chairman breaks ties).\n" +
      "- arena: members answer side by side and the user picks the winner.\n" +
      "Omit to use the configured default strategy.",
  }),
  question: Schema.optional(Schema.String).annotate({
    description:
      "The question the council deliberates on. Omit to print the resolved configuration and member roster instead of convening.",
  }),
  rounds: Schema.optional(Schema.Number).annotate({
    description: "Number of debate rounds (debate strategy only); clamped to 1-4, default 2.",
  }),
  members: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      'Inline override of the council members for this call: an array of "provider/model" strings, e.g. ' +
      '["anthropic/claude-opus-4-8","openai/gpt-5","google/gemini-2.5-pro"]. When omitted, members are read from ' +
      '.opencode/council.json (per-project) or the global council.json.',
  }),
})

type Metadata = {
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
  "You are one member of an expert council. Answer the question directly, thoroughly and honestly. Do not mention the council."
const CHAIR_SYSTEM =
  "You are the chairman of an expert council. Judge and combine the members' answers rigorously and without bias."
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
function block(answers: Ans[]): string {
  return answers.map((a, i) => `### [${i + 1}] ${a.name} (${a.model})\n${a.text}`).join("\n\n")
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

    // one-shot model call (mirrors Agent.generate); may fail into the error channel
    const ask = Effect.fn("CouncilTool.ask")(function* (model: string, system: string, user: string, temperature: number) {
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

    // never-failing member answer — a failure becomes a visible marker instead of killing the council
    const askSafe = (m: Member, system: string, user: string, temperature: number): Effect.Effect<Ans> =>
      ask(m.model, system, user, temperature).pipe(
        Effect.map((text): Ans => ({ name: m.name, model: m.model, text })),
        Effect.catchAll((e) => Effect.succeed({ name: m.name, model: m.model, text: `[${m.name} failed: ${String(e)}]` })),
        Effect.catchAllDefect((d) => Effect.succeed({ name: m.name, model: m.model, text: `[${m.name} crashed: ${String(d)}]` })),
      )

    const run = Effect.fn("CouncilTool.execute")(function* (args: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context) {
      const globalFile = join(Global.Path.config, FILE)
      const projectDir = yield* InstanceState.directory.pipe(
        Effect.catchAll(() => Effect.succeed("")),
        Effect.catchAllDefect(() => Effect.succeed("")),
      )
      const projectFile = projectDir ? join(projectDir, ".opencode", FILE) : ""

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

      // nothing configured -> seed global with the current model + print the path
      if (members.length === 0) {
        const cur = yield* provider.defaultModel().pipe(
          Effect.map((m) => `${m.providerID}/${m.modelID}`),
          Effect.catchAll(() => Effect.succeed("")),
          Effect.catchAllDefect(() => Effect.succeed("")),
        )
        let seeded = false
        if (!existsSync(globalFile)) {
          try {
            writeConfig(globalFile, {
              selection: "manual",
              members: [{ name: "current", model: cur }],
              chairman: cur,
              defaultStrategy: "council",
              rounds: 2,
            })
            seeded = true
          } catch {}
        }
        const out = [
          "No council is configured (it needs at least two models).",
          seeded && cur ? `Seeded the global config with your current model (${cur}).` : "Global council config:",
          `  ${globalFile}`,
          projectFile ? `Blank per-project override:\n  ${projectFile}` : "",
          `Add two or more "provider/model" entries and a "chairman", then run /council again.`,
          `A one-model council is pointless — for a single model use the normal task/subagent flow.`,
        ]
          .filter(Boolean)
          .join("\n")
        return { title: "council: not configured", output: out, metadata: { members: 0 } as Metadata }
      }

      const strategy = normStrategy(args.strategy || projectCfg?.defaultStrategy || globalCfg?.defaultStrategy || "council")
      const chairman = String(projectCfg?.chairman || globalCfg?.chairman || members[0].model).trim() || members[0].model
      const rounds = Math.max(1, Math.min(4, Number(args.rounds || projectCfg?.rounds || globalCfg?.rounds || 2)))
      const question = String(args.question || "").trim()

      const askChair = (system: string, user: string, temperature: number, fallback: string) =>
        ask(chairman, system, user, temperature).pipe(
          Effect.catchAll(() => Effect.succeed(fallback)),
          Effect.catchAllDefect(() => Effect.succeed(fallback)),
        )

      // no question -> status/list
      if (!question) {
        return {
          title: `council: ready (${members.length} members)`,
          output: [
            `Configured (${members.length} members, source: ${source}).`,
            members.map((m) => `  - ${m.name}: ${m.model}`).join("\n"),
            `chairman: ${chairman}   default strategy: ${strategy}`,
            `strategies: ${CANONICAL.join(", ")} (aliases: fusion=council, orchestrator/smart-router=router, map=moa, roundtable=debate, vote=consensus)`,
            `Call again with a question to convene.`,
          ].join("\n"),
          metadata: { strategy, members: members.length } as Metadata,
        }
      }

      if (members.length === 1 && strategy !== "router") {
        return {
          title: "council: only 1 model",
          output: `Only one model is configured (${members[0].model}); a council needs two or more. Edit ${source}, or use the normal task/subagent flow.`,
          metadata: { strategy, members: 1 } as Metadata,
        }
      }

      // shared answer pass for strategies that need every member's answer
      let answers: Ans[] = []
      if (["council", "compare", "moa", "consensus", "arena"].includes(strategy)) {
        answers = yield* Effect.all(
          members.map((m) => askSafe(m, MEMBER_SYSTEM, question, 0.7)),
          { concurrency: 4 },
        )
      }

      let output = ""
      let title = `council: ${strategy}`
      let winner: string | undefined

      if (strategy === "compare") {
        output = `## Compare — ${members.length} models, no synthesis\n\n${block(answers)}`
      } else if (strategy === "arena") {
        output = `## Arena — you pick the winner\n\n${block(answers)}\n\nTell me which number you prefer and I'll treat it as the final answer.`
      } else if (strategy === "council") {
        const final = yield* askChair(
          CHAIR_SYSTEM,
          `Question:\n${question}\n\nCouncil answers:\n\n${block(answers)}\n\nSynthesize one definitive answer: integrate the strongest points, resolve contradictions, correct errors. Output the final answer only.`,
          0.2,
          `[chairman synthesis unavailable]\n\n${block(answers)}`,
        )
        output = `## Council synthesis\n\n${final}\n\n---\n### Member answers\n\n${block(answers)}`
        title = `council: synthesized ${members.length} answers`
      } else if (strategy === "moa") {
        const final = yield* askChair(
          "You are the aggregator in a Mixture-of-Agents pipeline.",
          `Question:\n${question}\n\nProposed answers:\n\n${block(answers)}\n\nAggregate them into one higher-quality answer, keeping the best of each. Output the aggregated answer only.`,
          0.3,
          `[aggregation unavailable]\n\n${block(answers)}`,
        )
        output = `## Mixture-of-Agents\n\n${final}\n\n---\n### Proposers\n\n${block(answers)}`
      } else if (strategy === "router") {
        const roster = members.map((m, i) => `[${i + 1}] ${m.name} (${m.model})`).join("\n")
        const picked = yield* askChair(
          "You are a routing controller that selects the single best model for a task.",
          `Question:\n${question}\n\nModels:\n${roster}\n\nReply with ONLY the number of the best model.`,
          0,
          "1",
        )
        const idx = clampIndex(picked, members.length)
        const ans = yield* askSafe(members[idx], MEMBER_SYSTEM, question, 0.4)
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
            ask(m.model, "You are a strict evaluator.", scorePrompt, 0).pipe(
              Effect.catchAll(() => Effect.succeed("")),
              Effect.catchAllDefect(() => Effect.succeed("")),
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
            `Question:\n${question}\n\nCandidates:\n\n${listing}\n\nReply with ONLY the number of the best answer.`,
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
        // debate
        const transcript: { label: string; text: string }[] = []
        let current = yield* Effect.all(
          members.map((m) =>
            askSafe(m, "You are a debater on an expert panel.", `Question:\n${question}\n\nGive your opening position.`, 0.7),
          ),
          { concurrency: 4 },
        )
        current.forEach((a) => transcript.push({ label: `${a.name} (r1)`, text: a.text }))
        for (let r = 2; r <= rounds; r++) {
          const prev = current
          current = yield* Effect.all(
            members.map((m, i) =>
              askSafe(
                m,
                "You are a debater on an expert panel.",
                `Question:\n${question}\n\nOther members said:\n${prev
                  .filter((_, j) => j !== i)
                  .map((o) => `- ${o.name}: ${o.text}`)
                  .join("\n\n")}\n\nRebut, defend or refine your position (round ${r}).`,
                0.6,
              ),
            ),
            { concurrency: 4 },
          )
          current.forEach((a) => transcript.push({ label: `${a.name} (r${r})`, text: a.text }))
        }
        const final = yield* askChair(
          "You are the moderator resolving a debate.",
          `Question:\n${question}\n\nTranscript:\n\n${transcript
            .map((t) => `### ${t.label}\n${t.text}`)
            .join("\n\n")}\n\nResolve the debate into the single best-supported answer.`,
          0.2,
          "[moderator resolution unavailable]",
        )
        output = `## Debate — ${rounds} round(s)\n\n### Resolution\n${final}\n\n---\n### Transcript\n\n${transcript
          .map((t) => `#### ${t.label}\n${t.text}`)
          .join("\n\n")}`
        title = `council: debate resolved`
      }

      return { title, output, metadata: { strategy, members: members.length, ...(winner ? { winner } : {}) } as Metadata }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) => run(args, ctx).pipe(Effect.orDie),
    }
  }),
)
