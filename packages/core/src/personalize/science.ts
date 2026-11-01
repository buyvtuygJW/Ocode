import { Effect } from "effect"
import { Agent } from "@opencode/schema/agent"
import PROMPT_RESEARCH from "../plugin/prompt/research.txt"
import PROMPT_BIOLOGY from "../plugin/prompt/biology.txt"
import PROMPT_PHYSICS from "../plugin/prompt/physics.txt"
import PROMPT_ML from "../plugin/prompt/ml.txt"
import PROMPT_WRITE from "../plugin/prompt/write.txt"
import PROMPT_LITERATURE_REVIEW from "../plugin/prompt/literature-review.txt"
import PROMPT_CRITIQUE from "../plugin/prompt/critique.txt"
import PROMPT_PHYSICS_CRITIQUE from "../plugin/prompt/physics-critique.txt"
import PROMPT_REVIEWER from "../plugin/prompt/reviewer.txt"
export function decorate(stock: typeof import("../plugin/agent")) {
  return { Plugin: { ...stock.Plugin, effect: Effect.fn(function* (ctx: Parameters<typeof stock.Plugin.effect>[0]) {
    yield* stock.Plugin.effect(ctx)
    yield* ctx.agent.transform((editor) => {

      // --- OpenScience research agents (optional patch: FinalPersonalizeS) ---
      editor.update(Agent.ID.make("research"), (item) => {
        item.name = Agent.Name.make("Research")
        item.description =
          "Scientific research agent — literature review, data analysis, cloud GPU compute, and synthesis across a bundled science skill library."
        item.system = PROMPT_RESEARCH
        item.mode = "primary"
        item.color = "#06b6d4"
        item.permissions.push({ action: "question", resource: "*", effect: "allow" })
      })

      editor.update(Agent.ID.make("biology"), (item) => {
        item.name = Agent.Name.make("Biology")
        item.description =
          "Computational biology agent — bioinformatics analysis, 30+ biological database integrations, and systematic data-to-answer workflows."
        item.system = PROMPT_BIOLOGY
        item.mode = "all"
        item.color = "#10b981"
        item.permissions.push({ action: "question", resource: "*", effect: "allow" })
      })

      editor.update(Agent.ID.make("physics"), (item) => {
        item.name = Agent.Name.make("Physics")
        item.description =
          "Computational physics agent — simulation, PDE solving, dynamical systems, symbolic regression, data analysis, and scientific computing."
        item.system = PROMPT_PHYSICS
        item.mode = "all"
        item.color = "#8b5cf6"
        item.permissions.push({ action: "question", resource: "*", effect: "allow" })
      })

      editor.update(Agent.ID.make("ml"), (item) => {
        item.name = Agent.Name.make("ML")
        item.description =
          "Machine learning agent — trains, evaluates, and analyzes models end-to-end (deep learning, LLMs, classical ML, RL) with rigorous evaluation, and builds specialized models to replace frontier APIs."
        item.system = PROMPT_ML
        item.mode = "all"
        item.color = "#6366f1"
        item.permissions.push({ action: "question", resource: "*", effect: "allow" })
      })

      editor.update(Agent.ID.make("write"), (item) => {
        item.name = Agent.Name.make("Write")
        item.description =
          "Scientific & technical writing. Produces LaTeX papers, grants, literature reviews with verified citations and figures."
        item.system = PROMPT_WRITE
        item.mode = "subagent"
        item.color = "#a78bfa"
        item.permissions.push({ action: "question", resource: "*", effect: "allow" })
      })

      editor.update(Agent.ID.make("literature-review"), (item) => {
        item.name = Agent.Name.make("Literature Review")
        item.description =
          "Full PRISMA literature review — systematic search, screening, eligibility, synthesis, verification."
        item.system = PROMPT_LITERATURE_REVIEW
        item.mode = "subagent"
        item.color = "#818cf8"
        item.permissions.push(
          { action: "*", resource: "*", effect: "deny" },
          { action: "shell", resource: "*", effect: "allow" },
          { action: "read", resource: "*", effect: "allow" },
          { action: "read", resource: "*.env", effect: "ask" },
          { action: "read", resource: "*.env.*", effect: "ask" },
          { action: "read", resource: "*.env.example", effect: "allow" },
          { action: "glob", resource: "*", effect: "allow" },
          { action: "grep", resource: "*", effect: "allow" },
          { action: "webfetch", resource: "*", effect: "allow" },
          { action: "websearch", resource: "*", effect: "allow" },
          { action: "skill", resource: "*", effect: "allow" },
          { action: "external_directory", resource: "*", effect: "allow" },
        )
      })

      editor.update(Agent.ID.make("critique"), (item) => {
        item.name = Agent.Name.make("Critique")
        item.steps = 60
        item.description =
          "Scientific critique specialist. Finds blocking errors — data leakage, wrong statistics, unsupported claims — in research artifacts before expensive or irreversible actions. Read-only."
        item.system = PROMPT_CRITIQUE
        item.mode = "subagent"
        item.color = "#ef4444"
        item.permissions.push(
          { action: "*", resource: "*", effect: "deny" },
          { action: "read", resource: "*", effect: "allow" },
          { action: "read", resource: "*.env", effect: "ask" },
          { action: "read", resource: "*.env.*", effect: "ask" },
          { action: "read", resource: "*.env.example", effect: "allow" },
          { action: "glob", resource: "*", effect: "allow" },
          { action: "grep", resource: "*", effect: "allow" },
          { action: "skill", resource: "*", effect: "allow" },
          { action: "external_directory", resource: "*", effect: "allow" },
        )
      })

      editor.update(Agent.ID.make("physics-critique"), (item) => {
        item.name = Agent.Name.make("Physics Critique")
        item.steps = 60
        item.description =
          "Physics critique specialist — validates computational physics results (PDE solutions, PINN outputs, fitted parameters) against rigorous physical and numerical criteria. Read-only."
        item.system = PROMPT_PHYSICS_CRITIQUE
        item.mode = "subagent"
        item.color = "#c084fc"
        item.permissions.push(
          { action: "*", resource: "*", effect: "deny" },
          { action: "read", resource: "*", effect: "allow" },
          { action: "read", resource: "*.env", effect: "ask" },
          { action: "read", resource: "*.env.*", effect: "ask" },
          { action: "read", resource: "*.env.example", effect: "allow" },
          { action: "glob", resource: "*", effect: "allow" },
          { action: "grep", resource: "*", effect: "allow" },
          { action: "shell", resource: "*", effect: "allow" },
          { action: "external_directory", resource: "*", effect: "allow" },
        )
      })

      editor.update(Agent.ID.make("reviewer"), (item) => {
        item.name = Agent.Name.make("Reviewer")
        item.steps = 60
        item.description =
          "Blind, adversarial reviewer of research outputs. Traces every claim, number, and figure back to evidence — flags citation mismatches, untraceable numbers, and figure/stat mismatches. Read-only."
        item.system = PROMPT_REVIEWER
        item.mode = "subagent"
        item.color = "#f59e0b"
        item.permissions.push(
          { action: "*", resource: "*", effect: "deny" },
          { action: "read", resource: "*", effect: "allow" },
          { action: "read", resource: "*.env", effect: "ask" },
          { action: "read", resource: "*.env.*", effect: "ask" },
          { action: "read", resource: "*.env.example", effect: "allow" },
          { action: "glob", resource: "*", effect: "allow" },
          { action: "grep", resource: "*", effect: "allow" },
          { action: "shell", resource: "*", effect: "allow" },
          { action: "skill", resource: "*", effect: "allow" },
          { action: "external_directory", resource: "*", effect: "allow" },
        )
      })
    })
  }) } }
}
