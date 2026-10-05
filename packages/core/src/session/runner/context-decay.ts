import { SessionMessage } from "../message"

/**
 * Relevance-segmented context decay. Replaces fixed-budget compaction with a policy keyed on *which task you are on*:
 * the live task gets the big budget - including, especially, when it only just started - the task before it keeps a
 * small shared pot in case we bounce back, and everything older collapses to a retrieval ref. So a boundary cuts both
 * ways at once: it shrinks everything behind it and hands the fresh task a full budget.
 *
 * Tool output decays hard. Message text never decays; it is the reasoning thread, it is cheap, and losing it is what
 * makes agents repeat themselves. It is also why archived tools need no label - the chat around the call already says
 * what it did.
 */

// ---------------------------------------------------------------------------------------------------- tunables

/** Tool-output budget for the task we are on now. */
export const BUDGET_LIVE_TASK = 20_000
/** Shared pot for the task immediately before this one, in case we bounce back. */
export const BUDGET_PRIOR_TASK = 2_000
/** Turns compared either side of a candidate boundary. */
export const TASK_WINDOW = 3
/** Drift at or above which a new task provably began. */
export const TASK_DRIFT_THRESHOLD = 0.6
/** Share of drift owed to file paths; the remainder is vocabulary. */
export const PATH_WEIGHT = 0.6
/** Turns after which everything collapses into the single index block. */
export const ARCHIVE_AFTER_TURNS = 20
/** Head/tail retained when stubbing live-task output that overflowed. */
export const STUB_HEAD_CHARS = 400
export const STUB_TAIL_CHARS = 200
/** Consecutive tool calls with no reasoning between them that force a label. */
export const CHAIN_NARRATION_FLOOR = 5
/**
 * Re-evaluation quantum. Every drifting input is rounded down to a multiple of this, so the decision can only change
 * every N turns (or on a provable task switch). Without it the archive frontier advances one turn at a time, every turn
 * rewrites a different slice of the prefix, and the prompt cache misses forever - paying more than doing nothing at all.
 */
export const REEVAL_QUANTUM = 10

/** Rough token estimate. Deliberately cheap - this gates trimming, not billing. */
const tokens = (text: string) => Math.ceil(text.length / 4)

// ------------------------------------------------------------------------------------------------- path probes

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\/)[^\s]*$/

/** Pull absolute filesystem paths out of arbitrary tool input JSON. */
export const absolutePaths = (input: unknown, found: string[] = []): string[] => {
  if (typeof input === "string") {
    if (ABSOLUTE.test(input)) found.push(input.replaceAll("\\", "/"))
    return found
  }
  if (Array.isArray(input)) {
    for (const item of input) absolutePaths(item, found)
    return found
  }
  if (input && typeof input === "object") {
    for (const value of Object.values(input)) absolutePaths(value, found)
  }
  return found
}

const segments = (path: string) => path.split("/").filter(Boolean)

/**
 * Depth of the deepest shared ancestor. Two paths on the same drive but in unrelated trees (`D:/tmp/a` vs
 * `D:/Prog/Actdev/...`) share only the drive, which is depth 1 - a provable project boundary with no filesystem access.
 */
export const commonAncestorDepth = (left: string, right: string) => {
  const a = segments(left)
  const b = segments(right)
  let depth = 0
  while (depth < a.length && depth < b.length && a[depth]!.toLowerCase() === b[depth]!.toLowerCase()) depth++
  return depth
}

/** Paths are in the same project when they agree beyond the drive/filesystem root. */
const sameProject = (left: readonly string[], right: readonly string[]) => {
  if (left.length === 0 || right.length === 0) return true // no evidence is not evidence of change
  return left.some((l) => right.some((r) => commonAncestorDepth(l, r) > 1))
}

// ----------------------------------------------------------------------------------------------------- keywords

const WORD = /[a-z][a-z0-9_]{2,}/g

/** Filler that survives every topic switch and would mask real drift. */
const STOPWORD = new Set(
  `the and for you this that with not are was but have has from then than into out off now just like what why how when
   where which who will can should would could does done need want file files code line lines run running use used
   using add added fix fixed make made get got look looks next also only same still very much more most here there`
    .split(/\s+/)
    .filter(Boolean),
)

/** Content words of a turn. Short words and filler carry no topic signal. */
export const keywords = (text: string): ReadonlySet<string> =>
  new Set((text.match(WORD) ?? []).filter((word) => word.length >= 4 && !STOPWORD.has(word)))

// -------------------------------------------------------------------------------------------------------- turns

interface Turn {
  readonly message: SessionMessage.Message
  readonly tools: readonly SessionMessage.AssistantTool[]
  readonly paths: readonly string[]
  readonly text: string
  readonly words: ReadonlySet<string>
}

const toolsOf = (message: SessionMessage.Message): SessionMessage.AssistantTool[] => {
  if (message.role !== "assistant") return []
  return message.content.filter((item): item is SessionMessage.AssistantTool => item.type === "tool")
}

const textOf = (message: SessionMessage.Message) =>
  message.content
    .map((item) => ("text" in item && typeof item.text === "string" ? item.text : ""))
    .join(" ")
    .toLowerCase()

const toTurn = (message: SessionMessage.Message): Turn => {
  const tools = toolsOf(message)
  const text = textOf(message)
  const paths = tools.flatMap((tool) => absolutePaths(tool.state.status === "pending" ? {} : tool.state.input))
  return { message, tools, paths, text, words: keywords(text) }
}

// ------------------------------------------------------------------------------------------------ task boundaries

interface Window {
  readonly paths: readonly string[]
  readonly pathSet: ReadonlySet<string>
  readonly words: ReadonlySet<string>
}

const windowOf = (turns: readonly Turn[]): Window => {
  const paths = turns.flatMap((turn) => [...turn.paths])
  return { paths, pathSet: new Set(paths), words: new Set(turns.flatMap((turn) => [...turn.words])) }
}

/** 1 - overlap coefficient. Zero when either side offers no evidence. */
const overlapDrift = (left: ReadonlySet<string>, right: ReadonlySet<string>) => {
  if (left.size === 0 || right.size === 0) return 0
  const shared = [...right].filter((item) => left.has(item)).length
  return 1 - shared / Math.min(left.size, right.size)
}

/**
 * How far the work moved between two windows: 0 same task, 1 unrelated. Progressive on purpose - a repo change is a hard
 * 1 and needs no judgement, everything else is a blend of which files are touched and which words are used, so moving
 * from auth work to log trimming *inside one repo* scores high without anyone maintaining a list of magic keywords.
 */
export const drift = (prior: Window, live: Window): number => {
  if (!sameProject(prior.paths, live.paths)) return 1
  const paths = overlapDrift(prior.pathSet, live.pathSet)
  const words = overlapDrift(prior.words, live.words)
  return paths * PATH_WEIGHT + words * (1 - PATH_WEIGHT)
}

/**
 * Indices where a new task provably began, oldest first. A boundary needs a full window on both sides, so the newest
 * turns cannot mint one until the evidence exists - which is also what stops the newest turn from re-cutting the prefix
 * and missing the prompt cache every turn.
 */
export const taskBoundaries = (turns: readonly Turn[]): readonly number[] => {
  const marks: number[] = []
  for (let index = TASK_WINDOW; index + TASK_WINDOW <= turns.length; index++) {
    const last = marks[marks.length - 1]
    if (last !== undefined && index - last < TASK_WINDOW) continue
    if (drift(windowOf(turns.slice(index - TASK_WINDOW, index)), windowOf(turns.slice(index, index + TASK_WINDOW))) >= TASK_DRIFT_THRESHOLD)
      marks.push(index)
  }
  return marks
}

/** 0 for the task we are on, 1 for the one before it, and so on back. */
export const taskRank = (index: number, marks: readonly number[]) => marks.filter((mark) => mark > index).length

/**
 * Budget as a function of rank - the whole policy in three lines. Rank 0 is the live task and is never penalised for
 * being new; rank 2 and older hold no verbatim output at all, they are a ref you can pull back on demand.
 */
export const taskBudget = (rank: number) => {
  if (rank === 0) return BUDGET_LIVE_TASK
  if (rank === 1) return BUDGET_PRIOR_TASK
  return 0
}

/**
 * Tools inside an unnarrated chain: CHAIN_NARRATION_FLOOR or more consecutive calls with no reasoning text between
 * them. Everywhere else the surrounding chat already says what the call did, so the archive carries a bare ref and pays
 * ~10 tokens instead of a redundant label.
 */
export const unnarrated = (turns: readonly Turn[]): ReadonlySet<string> => {
  const marked = new Set<string>()
  let run: string[] = []
  const flush = () => {
    if (run.length >= CHAIN_NARRATION_FLOOR) for (const id of run) marked.add(id)
    run = []
  }
  for (const turn of turns) {
    if (turn.text.trim().length > 0) flush()
    for (const tool of turn.tools) run.push(tool.id)
  }
  flush()
  return marked
}

/**
 * Everything that can change what the decayed prefix looks like, reduced to three ints. Equal key => byte-identical
 * output => skip the work and keep the provider cache hot. This is the loop-breaker: the expensive decision is made on
 * a boundary, not on every turn.
 */
export interface ContextKey {
  /** Count of provable task boundaries seen. Monotonic. */
  readonly segment: number
  /** Archive frontier, quantized so it steps rather than slides. */
  readonly frontier: number
  /** First turn of the live task. */
  readonly live: number
}

const quantize = (value: number) => Math.max(0, Math.floor(value / REEVAL_QUANTUM) * REEVAL_QUANTUM)

export const contextKey = (turns: readonly Turn[]): ContextKey => {
  const marks = taskBoundaries(turns)
  return { segment: marks.length, frontier: quantize(turns.length - ARCHIVE_AFTER_TURNS), live: marks[marks.length - 1] ?? 0 }
}

export const sameKey = (left: ContextKey | undefined, right: ContextKey) =>
  left !== undefined && left.segment === right.segment && left.frontier === right.frontier && left.live === right.live

// -------------------------------------------------------------------------------------------------------- decay

const contentText = (tool: SessionMessage.AssistantTool) => {
  if (tool.state.status !== "completed" && tool.state.status !== "error") return ""
  return tool.state.content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join("\n")
}

const stub = (tool: SessionMessage.AssistantTool, body: string) => {
  const head = body.slice(0, STUB_HEAD_CHARS)
  const tail = body.length > STUB_HEAD_CHARS + STUB_TAIL_CHARS ? body.slice(-STUB_TAIL_CHARS) : ""
  const paths = tool.state.status === "completed" ? (tool.state.outputPaths ?? []) : []
  const handle = paths[0] ?? tool.id
  const note = `\n…[${tool.name} output elided — ${body.length} chars. ref ${handle} — name it and the harness reinjects it locally]…\n`
  return [head, note, tail].join("")
}

/** An elided tool keeps outputPaths so the harness can refetch without a provider call. */
const elide = (tool: SessionMessage.AssistantTool, body: string): SessionMessage.AssistantTool => {
  if (tool.state.status !== "completed" && tool.state.status !== "error") return tool
  return { ...tool, state: { ...tool.state, content: [{ type: "text", text: stub(tool, body) }] } } as SessionMessage.AssistantTool
}

/**
 * Superseded/old output collapses to a bare ref - the consolidated index block carries the detail, so repeating it
 * per-tool would defeat the point. Content is never emptied outright: an empty tool result trips provider-side
 * tool_call/tool_result pairing checks.
 */
const archivedMarker = (tool: SessionMessage.AssistantTool, ref: string): SessionMessage.AssistantTool => {
  if (tool.state.status !== "completed" && tool.state.status !== "error") return tool
  return { ...tool, state: { ...tool.state, content: [{ type: "text", text: `[archived — ref ${ref}]` }] } } as SessionMessage.AssistantTool
}

export interface ArchiveEntry {
  readonly id: string
  readonly ref: string
  /** Carried only for unnarrated chains; elsewhere the chat is the label. */
  readonly name?: string
  readonly chars?: number
}

export interface DecayResult {
  readonly messages: readonly SessionMessage.Message[]
  readonly archive: readonly ArchiveEntry[]
  readonly key: ContextKey
  /** False when the short-circuit fired and the prefix was left byte-identical. */
  readonly rewritten: boolean
}

/**
 * Decay a projected history immediately before it is lowered to provider messages. Pure and synchronous: no filesystem,
 * no git, no Effect, so it can sit inside `toLLMMessages` without changing its signature.
 */
export const decay = (messages: readonly SessionMessage.Message[], previous?: ContextKey): DecayResult => {
  const turns = messages.map(toTurn)
  const key = contextKey(turns)

  // Loop-breaker. Nothing affecting the lowered bytes changed, so hand back the same references and let the cache hit.
  if (sameKey(previous, key)) return { messages, archive: [], key, rewritten: false }

  const marks = taskBoundaries(turns)
  const labelled = unnarrated(turns)
  const archiveBefore = key.frontier
  const archive: ArchiveEntry[] = []

  // Decide every tool's fate newest-first so the freshest output claims budget first, then rebuild in original order.
  const verdict = new Map<string, SessionMessage.AssistantTool>()
  const spent = new Map<number, number>()

  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]!
    const rank = taskRank(index, marks)
    const allowance = taskBudget(rank)
    const archived = index < archiveBefore

    for (const tool of turn.tools) {
      const body = contentText(tool)
      if (body.length === 0) continue

      const paths = tool.state.status === "completed" ? (tool.state.outputPaths ?? []) : []
      const ref = paths[0] ?? tool.id
      const label = labelled.has(tool.id)
      const retire = () => {
        archive.push(label ? { id: tool.id, ref, name: tool.name, chars: body.length } : { id: tool.id, ref })
        verdict.set(tool.id, archivedMarker(tool, ref))
      }

      if (archived || allowance === 0) {
        retire()
        continue
      }

      const cost = tokens(body)
      const used = spent.get(rank) ?? 0
      if (used + cost <= allowance) {
        spent.set(rank, used + cost)
        continue // keep verbatim
      }

      // Overflow in the live task keeps a head/tail so the thread still reads; an older task is cold, so it goes to a ref.
      if (rank === 0) verdict.set(tool.id, elide(tool, body))
      else retire()
    }
  }

  archive.reverse() // filled newest-first; present it oldest-first like the transcript

  const next = messages.map((message) => {
    if (message.role !== "assistant") return message
    if (!message.content.some((item) => item.type === "tool" && verdict.has(item.id))) return message
    const content = message.content.map((item) => (item.type === "tool" && verdict.has(item.id) ? verdict.get(item.id)! : item))
    return { ...message, content } as SessionMessage.Message
  })

  return { messages: next, archive, key, rewritten: true }
}

/**
 * Single consolidated block standing in for everything archived. Bare refs: the chat above each call already says what
 * it was for, and a label per entry would cost more than the entries it describes.
 */
export const indexBlock = (archive: readonly ArchiveEntry[]) => {
  if (archive.length === 0) return undefined
  const lines = archive.map((entry) => (entry.name ? `  ${entry.ref} — ${entry.name}, ${entry.chars} chars` : `  ${entry.ref}`))
  return [
    `<archived-tool-output count="${archive.length}">`,
    "Tool output elided. Name any ref to have the harness reinject it locally.",
    ...lines,
    "</archived-tool-output>",
  ].join("\n")
}
