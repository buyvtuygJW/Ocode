import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Global } from "@opencode-ai/core/global"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import DESCRIPTION from "./schedule.txt"

// Deterministic qm-style background schedules ("crons and watches run work while
// nobody's watching") — ported as native code. NO LLM, NO server, NO Postgres.
// Schedules are plain JSON in the global opencode config dir; the built-in /schedule
// command executes whatever is due inside a normal session, and `export` emits
// OS-scheduler lines (crontab / schtasks) that run `opencode run "<prompt>"` truly
// unattended, without an open session.

const FILE = "schedules.json"

export const Parameters = Schema.Struct({
  action: Schema.Literal("add", "list", "remove", "due", "mark", "export"),
  name: Schema.optional(Schema.String),
  every: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
})

type Metadata = {
  count?: number
  due?: number
}

// ---- storage ----------------------------------------------------------------
function storePath(): string {
  return join(Global.Path.config, FILE)
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
        "For truly unattended runs (no open session), register these with the OS scheduler.\n" +
        "crontab (crontab -e):\n" +
        cron.join("\n") +
        "\nWindows (adjust /SC and /ST to the cadence):\n" +
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
export const ScheduleTool = Tool.define<typeof Parameters, Metadata, never>(
  "schedule_task",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const r = yield* Effect.sync(() => run(args as any))
          return {
            title: r.title,
            output: r.output,
            metadata: { count: r.count, due: r.due },
          }
        }),
    } satisfies Tool.DefWithoutID<typeof Parameters, Metadata>
  }),
)
