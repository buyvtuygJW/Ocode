export * as PersonalizePlugin from "./personalize.js"

// ============================================================================
// PERSONALIZATION (FinalPersonalizeR) — SINGLE owned file.
// Everything for /distill, /schedule, /council lives HERE: tools, commands,
// config resolution. Ported onto the 2.0.29 plugin architecture: tools are
// registered via ctx.tool.transform, commands via ctx.command.transform, and
// owned one-shot generation uses the shared model resolver/client; session-aware
// chair/distill requests retain prepared context without stock generation retries.
// ============================================================================

import { define } from "@opencode/plugin/effect/plugin"
import { Tool } from "@opencode/schema/tool"
import { Model as ModelSchema } from "@opencode/schema/model"
import { Provider as ProviderSchema } from "@opencode/schema/provider"
import type { Session as SessionSchema } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import { Global } from "@opencode/util/global"
import { FSUtil } from "@opencode/util/fs-util"
import { Cron, DateTime, Effect } from "effect"
import path from "path"
import { randomUUID } from "node:crypto"
import { LanguageModel, LLMClient, Message, type RequestOptions } from "@opencode/ai/effect"
import { HttpClientRequest } from "effect/http"
import { Model } from "../model.js"
import { Session } from "../session.js"
import { Schedule } from "../schedule.js"
import { SessionContext } from "../session/context.js"
import { Instance } from "../instance/service.js"
import { Database } from "../database/database.js"
import { SessionHistory } from "../session/history.js"
import { SessionModelRequest } from "../session/model-request.js"
import { Service as ModelResolverService } from "../model-resolver.js"
import { capRequest } from "../personalize/output-request"

// ----------------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------------

type MemberRef = { readonly name: string; readonly model: ModelSchema.Ref }

const parseModelRef = (raw: string): ModelSchema.Ref | undefined => {
  const trimmed = raw.trim()
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash === trimmed.length - 1) return undefined
  return {
    providerID: ProviderSchema.ID.make(trimmed.slice(0, slash)),
    id: ModelSchema.ID.make(trimmed.slice(slash + 1)),
  }
}

const refToString = (ref: ModelSchema.Ref) => `${ref.providerID}/${ref.id}`

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const readJsonSafe = (fs: FSUtil.Interface, file: string) => Effect.gen(function* () {
  const raw = yield* fs.readFileString(file).pipe(
    Effect.catchIf((cause) => record(cause) &&
      (cause.code === "ENOENT" || (record(cause.reason) && cause.reason._tag === "NotFound")),
    () => Effect.succeed(undefined)),
    Effect.mapError((cause) => new Tool.Error({ message: `Cannot read ${file}; file preserved: ${cause}` })),
  )
  if (raw === undefined || raw.trim() === "") return undefined
  const parsed: unknown = yield* Effect.try({
    try: () => JSON.parse(raw),
    catch: () => new Tool.Error({ message: `Invalid JSON in ${file}; file preserved. Repair it, or explicitly empty it/reset it to {}.` }),
  })
  return record(parsed) && Object.keys(parsed).length === 0 ? undefined : parsed
})

const writeJsonSafe = (fs: FSUtil.Interface, file: string, value: unknown) =>
  fs.ensureDir(path.dirname(file)).pipe(
    Effect.andThen(fs.writeJson(file, value)),
    Effect.mapError((cause) => new Tool.Error({ message: `Cannot write ${file}: ${cause}` })),
  )

const text = (value: string): Tool.Result => ({ content: [{ type: "text", text: value }] })

// ----------------------------------------------------------------------------
// DISTILL — RSI (Recursive Self-Improvement) skill distillation.
// Deterministically scores the CURRENT session trajectory, and only if it
// scores >= THRESHOLD reconstructs a reusable learned skill using RSI.
// ----------------------------------------------------------------------------

const THRESHOLD = 75

const DESC_DISTILL =
  "Deterministically distill the CURRENT session into a reusable learned skill using RSI " +
  "(Recursive Self-Improvement) heuristic — NO LLM scoring. Reconstructs this session's tool " +
  "trajectory, scores it 0-100 on Correctness/Efficiency/Coverage/Reproducibility, and only if " +
  "it scores >= 75 writes a reusable learned skill under global opencode skills dir (or project " +
  ".opencode/skills dir when `project` is true). Returns score breakdown and either saved skill " +
  "path or reason it was not distilled.\n"

const PROMPT_DISTILL =
  "Call `distill_session` tool now with action=\"run\".\n\n$ARGUMENTS\n\n" +
  "If arguments mention 'project', pass project=true. Relay the score breakdown and the saved " +
  "skill path (or the skip reason) exactly as reported. Do not invent scores.\n"

type DistillInput = {
  action?: "run" | "preview"
  project?: boolean
  name?: string
}

type TrajectoryStats = {
  userTurns: number
  assistantTurns: number
  toolCalls: number
  toolErrors: number
  distinctTools: string[]
  failedIdles: number
  interrupted: number
  firstUserText: string
}

const captureTrajectory = (messages: readonly SessionMessage.Info[]) => {
  const stats: TrajectoryStats = {
    userTurns: 0,
    assistantTurns: 0,
    toolCalls: 0,
    toolErrors: 0,
    distinctTools: [],
    failedIdles: 0,
    interrupted: 0,
    firstUserText: "",
  }
  const tools = new Set<string>()
  for (const message of messages) {
    if (message.type === "user") {
      stats.userTurns += 1
      if (!stats.firstUserText) stats.firstUserText = message.text.slice(0, 500)
      continue
    }
    if (message.type === "idle") {
      if (message.outcome === "failed") stats.failedIdles += 1
      if (message.outcome === "interrupted") stats.interrupted += 1
      continue
    }
    if (message.type !== "assistant") continue
    stats.assistantTurns += 1
    for (const part of message.content) {
      if (part.type !== "tool") continue
      stats.toolCalls += 1
      tools.add(part.name)
      if (part.state.status === "error") stats.toolErrors += 1
    }
  }
  stats.distinctTools = [...tools].sort()
  return stats
}

// Deterministic RSI scoring — identical weights to the original patch:
// Correctness: starts at 100, -25 per failed idle, -8 per tool error (floor 0).
// Efficiency: 100 when <= 20 tool calls, linear decay to 20 at 120 calls.
// Coverage: 20 + 16 per distinct tool, capped at 100.
// Reproducibility: 100 with no interruptions and >= 1 tool call, else penalized.
const scoreTrajectory = (stats: TrajectoryStats) => {
  const correctness = Math.max(0, 100 - stats.failedIdles * 25 - stats.toolErrors * 8)
  const efficiency =
    stats.toolCalls <= 20 ? 100 : Math.max(20, Math.round(100 - ((stats.toolCalls - 20) * 80) / 100))
  const coverage = Math.min(100, 20 + stats.distinctTools.length * 16)
  const reproducibility = Math.max(
    0,
    (stats.toolCalls >= 1 ? 100 : 40) - stats.interrupted * 30 - stats.failedIdles * 10,
  )
  const total = Math.round(correctness * 0.4 + efficiency * 0.2 + coverage * 0.2 + reproducibility * 0.2)
  return { correctness, efficiency, coverage, reproducibility, total }
}

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "learned-skill"

// ----------------------------------------------------------------------------
// SCHEDULE — adapter to the shared, database-backed execution engine.
// Old JSON records remain exportable; never silently activate legacy jobs.
// ----------------------------------------------------------------------------

const DESC_SCHEDULE =
  "Manage executable schedules for the current session using the shared schedule engine. " +
  "Requires experimental.schedules=true and a running server; due prompts may invoke the model/tools. " +
  "Actions: add (name + cadence + prompt), list, remove (name or id), export. " +
  "Legacy scheduled_tasks.json records are export-only until explicitly recreated.\n"

const PROMPT_SCHEDULE =
  "Manage schedules via the `schedule_task` tool.\n\n$ARGUMENTS\n\n" +
  "Map the request onto one action: add (needs name + cadence + prompt), list, remove (name), or " +
  "export. Cadence accepts 5-field cron (m h dom mon dow) or shorthand: @hourly, @daily, @weekly, " +
  "every <N> minutes/hours. Relay actual engine status/errors; never claim execution merely from a stored record.\n"

type ScheduleEntry = {
  name: string
  cadence: string
  prompt: string
  created: string
  last?: string
}

type ScheduleInput = {
  action?: "add" | "list" | "remove" | "export"
  name?: string
  cadence?: string
  prompt?: string
}

const matchField = (field: string, value: number, max: number): boolean => {
  if (field === "*") return true
  return field.split(",").some((part) => {
    const step = part.split("/")
    const range = step[0] ?? "*"
    const every = step[1] === undefined ? 1 : Number(step[1])
    if (!Number.isFinite(every) || every <= 0) return false
    let lo = 0
    let hi = max
    if (range !== "*") {
      const bounds = range.split("-")
      const from = Number(bounds[0])
      const to = bounds[1] === undefined ? from : Number(bounds[1])
      if (!Number.isFinite(from) || !Number.isFinite(to)) return false
      lo = from
      hi = to
    }
    return value >= lo && value <= hi && (value - lo) % every === 0
  })
}

const normalizeCadence = (cadence: string): string | undefined => {
  const value = cadence.trim().toLowerCase()
  if (value === "@hourly") return "0 * * * *"
  if (value === "@daily") return "0 9 * * *"
  if (value === "@weekly") return "0 9 * * 1"
  const every = value.match(/^every\s+(\d+)\s+(minute|minutes|hour|hours)$/)
  if (every) {
    const n = Number(every[1])
    const unit = every[2]!.startsWith("minute") ? "minutes" : "hours"
    if (n <= 0 || !Number.isSafeInteger(n * (unit === "hours" ? 3_600_000 : 60_000))) return undefined
    return `every ${n} ${unit}`
  }
  const fields = value.split(/\s+/)
  if (fields.length !== 5) return undefined
  try { Cron.parseUnsafe(fields.join(" ")); return fields.join(" ") } catch { return undefined }
}

const cronMatches = (cron: string, date: Date): boolean => {
  const [minute, hour, dom, month, dow] = cron.split(" ")
  return (
    matchField(minute ?? "*", date.getMinutes(), 59) &&
    matchField(hour ?? "*", date.getHours(), 23) &&
    matchField(dom ?? "*", date.getDate(), 31) &&
    matchField(month ?? "*", date.getMonth() + 1, 12) &&
    matchField(dow ?? "*", date.getDay(), 6)
  )
}

const nextRun = (cron: string, from: Date): Date | undefined => {
  const interval = cron.match(/^every (\d+) (minutes|hours)$/)
  if (interval) {
    const next = new Date(from.getTime() + Number(interval[1]) * (interval[2] === "hours" ? 3_600_000 : 60_000))
    return Number.isFinite(next.getTime()) ? next : undefined
  }
  try { return Cron.next(Cron.parseUnsafe(cron), from) } catch { return undefined }
}

const isDue = (entry: ScheduleEntry, now: Date): boolean => {
  const since = new Date(entry.last ?? entry.created)
  const upcoming = nextRun(entry.cadence, since)
  return upcoming !== undefined && upcoming.getTime() <= now.getTime()
}

// ----------------------------------------------------------------------------
// COUNCIL — fan the same question to several models and combine the answers.
// ----------------------------------------------------------------------------

const DESC_COUNCIL =
  "Convene a multi-model council: fan the same question to several models directly (bypasses the " +
  "task tool's single-model limit) and combine their answers by strategy. See the `strategy` " +
  "parameter for the seven modes and their aliases.\n\nMembers come from council.json — a " +
  'per-project ".opencode/council.json" overrides the global config dir. Resolution: the inline ' +
  "`members` argument, else the per-project file (entries with " +
  'an empty "model" are skipped), else the global file.\n\nIf nothing is configured, the tool ' +
  "seeds the global council.json with your current model and prints its path. A council needs at " +
  "least two models; with one, use the normal task/subagent flow.\n"

const PROMPT_COUNCIL =
  "Convene a council on this request via `council`.\n\n$ARGUMENTS\n\n" +
  "Pass user's question as `question`. If a strategy was named (council, compare, debate, moa, " +
  "router, consensus, arena — aliases ok), pass it; else omit. Do not answer yourself first.\n\n" +
  "Relay results as-is: synthesized/resolved answer for council/moa/debate; side-by-side for " +
  "compare/arena (for arena, ask which to keep); winner + scoreboard for consensus; chosen model " +
  "for router.\n\nIf not configured, print returned file path and tell user to add two or more " +
  '"provider/model" entries — do not invent models.\n'

const CHAIR_SYSTEM =
  "You are the chairman of an expert council. Judge and combine the members' answers rigorously and without bias."

const STRATEGY_ALIASES: Record<string, string> = {
  council: "council",
  synth: "council",
  compare: "compare",
  sidebyside: "compare",
  debate: "debate",
  roundtable: "debate",
  moa: "moa",
  map: "moa",
  router: "router",
  route: "router",
  consensus: "consensus",
  vote: "consensus",
  arena: "arena",
}

type CouncilInput = {
  question?: string
  strategy?: string
  members?: string[]
  rounds?: number
}

type MemberAnswer = { readonly member: MemberRef; readonly answer: string; readonly failed?: boolean }

type Checked<T> = { ok: true; value: T } | { ok: false; error: string }
const checkJson = <T>(raw: string, validate: (value: unknown) => T): Checked<T> => {
  try { return { ok: true, value: validate(JSON.parse(raw)) } }
  catch (cause) { return { ok: false, error: cause instanceof SyntaxError ? "Invalid JSON; return one JSON object without markdown." : String(cause) } }
}
const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))

const validateBallot = (raw: string, count: number) => checkJson(raw, (value) => {
  if (!exactKeys(value, ["scores"]) || !Array.isArray(value.scores) || value.scores.length !== count)
    throw new Error(`Expected {"scores":[{"member":1,"score":1},...]} with exactly ${count} entries.`)
  const scores = new Map<number, number>()
  for (const entry of value.scores) {
    if (!exactKeys(entry, ["member", "score"]) || !Number.isInteger(entry.member) ||
      typeof entry.member !== "number" || entry.member < 1 || entry.member > count || scores.has(entry.member) ||
      typeof entry.score !== "number" || !Number.isFinite(entry.score) || entry.score < 1 || entry.score > 10)
      throw new Error("Each numbered member must occur exactly once; scores must be finite numbers from 1 through 10.")
    scores.set(entry.member, entry.score)
  }
  return scores
})

const validateRoute = (raw: string, count: number) => checkJson(raw, (value) => {
  if (!exactKeys(value, ["member"]) || typeof value.member !== "number" || !Number.isInteger(value.member) || value.member < 1 || value.member > count)
    throw new Error(`Expected {"member":N}, where N is an integer from 1 through ${count}.`)
  return value.member - 1
})

const validateAnswer = (raw: string) => checkJson(raw, (value) => {
  if (!exactKeys(value, ["answer"]) || typeof value.answer !== "string" || !value.answer.trim())
    throw new Error('Expected {"answer":"non-empty answer text"}.')
  return value.answer
})

// ----------------------------------------------------------------------------
// Plugin
// ----------------------------------------------------------------------------

// Members get an explicit, stateless prompt, not stock session generation. Drop
// affinity / diagnostic identifiers from both defaults and provider overrides;
// never walk messages (a user's JSON is content, not request metadata).
const memberIdentifier = (key: string) =>
  /^(id|user|metadata|safetyidentifier|promptcachekey|promptcacheid|sessionid|conversation|conversationid|previousresponseid|threadid|requestid|clientrequestid|traceid)$/.test(
    key.replace(/[-_]/g, "").toLowerCase(),
  )

function memberFields<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !memberIdentifier(key))) as T
}

const memberHeader = (key: string) => {
  const name = key.toLowerCase()
  return name.startsWith("x-opencode-") || name.startsWith("x-pxpipe-") ||
    /^(session[-_]id|conversation[-_]id|x-(client-)?(session|conversation|request|correlation)-id|client-request-id|x-(oai|openai)-(session|request)-id|traceparent|tracestate|baggage)$/.test(name)
}

export function councilMemberOptions(options: RequestOptions = {}): RequestOptions {
  const headers = options.headers && Object.fromEntries(
    Object.entries(options.headers).filter(([key]) => !memberHeader(key)),
  )
  const providerOptions = options.providerOptions && Object.fromEntries(
    Object.entries(options.providerOptions).map(([provider, value]) => [provider,
      value !== null && typeof value === "object" && !Array.isArray(value) ? memberFields(value) : value,
    ]),
  )
  const http = options.http && {
    ...options.http,
    body: options.http.body && memberFields(options.http.body),
  }
  return { ...memberFields(options), headers, providerOptions, http }
}

export function councilTraceOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (!["http:", "https:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      url.username || url.password || url.pathname !== "/" || url.search || url.hash) return undefined
    return url.origin
  } catch { return undefined }
}

// This boundary runs AFTER route headers and transport authentication. Keep
// auth/routing headers (Authorization, x-api-key, chatgpt-account-id, etc.).
// Opt-in trace ids are random correlation ids, never local session identifiers.
export function councilMemberWire(
  request: HttpClientRequest.HttpClientRequest,
  trace?: { origin: string; id: string },
): HttpClientRequest.HttpClientRequest {
  let result = request
  for (const key of Object.keys(request.headers)) {
    if (memberHeader(key)) result = HttpClientRequest.removeHeader(result, key)
  }
  if (request.body._tag === "Uint8Array" && request.body.contentType.includes("json")) {
    const body = JSON.parse(new TextDecoder().decode(request.body.body))
    if (body && typeof body === "object" && !Array.isArray(body)) {
      result = HttpClientRequest.bodyUint8Array(
        result,
        new TextEncoder().encode(JSON.stringify(memberFields(body))),
        request.body.contentType,
      )
      result = HttpClientRequest.removeHeader(result, "content-length")
    }
  }
  if (trace) {
    const url = new URL(request.url)
    // Explicit origin AND loopback are required. A configured remote provider
    // must never receive proxy-only headers, even when tracing is enabled.
    if (url.origin === trace.origin && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      result = HttpClientRequest.setHeaders(result, {
        "x-pxpipe-debug": "1",
        "x-pxpipe-local-session": trace.id,
      })
    }
  }
  return result
}

export const Plugin = define({
  id: "opencode.personalize",
  effect: Effect.fn(function* (ctx) {
    const global = yield* Global.Service
    const fs = yield* FSUtil.Service
    const sessions = yield* Session.Service
    const models = yield* Model.Service
    const memberModels = yield* ModelResolverService
    const memberClient = yield* LLMClient.Service
    const instances = yield* Instance.Service
    const database = yield* Database.Service
    const schedules = yield* Schedule.Service
    const projectDirectory = ctx.location.directory

    const globalCouncilPath = path.join(global.config, "council.json")
    const schedulePath = path.join(global.config, "scheduled_tasks.json")

    const complete = Effect.fn(function* (request: Parameters<typeof memberClient.generate>[0], options?: Parameters<typeof memberClient.generate>[1]) {
      const generate = () => memberClient.generate(request, options)
      const first = yield* generate()
      // One retry for length only, with the identical request/cap and no partial.
      const result = first.finishReason.normalized === "length" ? yield* generate() : first
      if (result.finishReason.normalized !== "stop" || !result.text.trim())
        return yield* new Tool.Error({ message: `Owned generation did not produce a complete answer (${result.finishReason.normalized}); partial output discarded.` })
      return result.text
    })

    const askSession = Effect.fn(function* (sessionID: SessionSchema.ID, prompt: string) {
      const session = yield* sessions.get(sessionID)
      return yield* Effect.gen(function* () {
        const context = yield* SessionContext.Service
        const selection = yield* context.select(sessionID)
        const model = yield* context.resolveModel(selection.session)
        const history = yield* SessionHistory.preview(database.db, selection.session.id, selection.instructions, model.ref)
        const transcript = SessionModelRequest.baseTranscript({
          agent: selection.agent.info, model, tools: selection.tools, initial: history.initial, messages: history.messages,
        })
        const prepared = yield* context.request.generate({
          session: selection.session, agent: selection.agent.id, model, tools: selection.tools,
          system: transcript.system,
          messages: [...transcript.messages, ...(history.instructionUpdate ? [Message.system(history.instructionUpdate)] : []), Message.user(prompt)],
        })
        // Preserve the chair's canonical session identity and prepared transports.
        // Stateless member scrubbing belongs only to askCouncilMember below.
        return yield* complete(capRequest(prepared.request, model), prepared.options)
      }).pipe(instances.provide(session))
    })

    // Stateless member prompts; chair/distill use askSession's prepared context.
    const askCouncilMember = Effect.fn(function* (input: {
      parentID: SessionSchema.ID
      model: ModelSchema.Ref
      prompt: string
    }) {
      const child = yield* sessions.create({ parentID: input.parentID, title: "Council member", model: input.model })
      const resolved = yield* memberModels.resolve(input.model)
      if (!resolved) return yield* new Tool.Error({ message: `Council member unavailable: ${input.model.providerID}/${input.model.id}` })
      const options = councilMemberOptions(resolved.model.options)
      const request = capRequest({
        ...options,
        model: new LanguageModel({ ...LanguageModel.input(resolved.model), options }),
        system: [],
        messages: [Message.user(input.prompt)],
        tools: [],
      }, resolved)
      const origin = councilTraceOrigin(process.env.OPENCODE_COUNCIL_PROXY_TRACE_ORIGIN)
      const trace = origin ? { origin, id: randomUUID() } : undefined
      if (trace) {
        yield* Effect.logInfo("Council proxy-only trace (local mapping)", {
          traceID: trace.id, proxyOrigin: trace.origin, parentID: input.parentID, sessionID: child.id,
        })
      }
      return yield* complete(request, {
        http: (wire, next) => Effect.suspend(() => next(councilMemberWire(wire, trace))),
      })
    })

    const loadMembers = Effect.fn(function* (inline: readonly string[] | undefined) {
      if (inline !== undefined && inline.length > 0) {
        const members: MemberRef[] = []
        for (const raw of inline) {
          const ref = parseModelRef(raw)
          if (ref === undefined) return { error: `Invalid member "${raw}" — expected "provider/model".` }
          members.push({ name: `member${members.length + 1}`, model: ref })
        }
        return { members }
      }
      const projectPath = path.join(projectDirectory, ".opencode", "council.json")
      for (const file of [projectPath, globalCouncilPath]) {
        const parsed = yield* readJsonSafe(fs, file)
        if (parsed === undefined) continue
        if (!record(parsed) || !Array.isArray(parsed.members))
          return yield* new Tool.Error({ message: `Invalid council structure in ${file}; expected a members array. File preserved.` })
        const entries = parsed.members as unknown[]
        const members: MemberRef[] = []
        for (const entry of entries) {
          if (!record(entry) || typeof entry.model !== "string" || (entry.name !== undefined && typeof entry.name !== "string"))
            return yield* new Tool.Error({ message: `Invalid council member in ${file}; model and optional name must be strings. File preserved.` })
          if (!entry.model.trim()) continue // blank template entries are skipped
          const ref = parseModelRef(entry.model)
          if (ref === undefined) return yield* new Tool.Error({ message: `Invalid member model in ${file}: ${entry.model}. File preserved.` })
          const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : `member${members.length + 1}`
          if (members.some((member) => member.name === name)) return yield* new Tool.Error({ message: `Duplicate member name in ${file}: ${name}. File preserved.` })
          members.push({ name, model: ref })
        }
        return { members, path: file }
      }
      return { members: [] as MemberRef[] }
    })

    const seedCouncil = Effect.fn(function* (sessionID: SessionSchema.ID) {
      // Recheck immediately before writing. A valid but blank members array is
      // intentional configuration, not permission to overwrite the file.
      if ((yield* readJsonSafe(fs, globalCouncilPath)) !== undefined) return { path: globalCouncilPath, seeded: false }
      const session = yield* sessions
        .get(sessionID)
        .pipe(Effect.mapError((cause) => new Tool.Error({ message: `Cannot read session: ${cause}` })))
      const available = yield* models.available()
      const current = session.model && available.some((model) => refToString(model) === refToString(session.model!))
        ? refToString(session.model) : undefined
      // Session/model lookup yields; recheck after it immediately before saving.
      if ((yield* readJsonSafe(fs, globalCouncilPath)) !== undefined) return { path: globalCouncilPath, seeded: false }
      const seed = {
        members: [
          { name: "current", model: current ?? "" },
          { name: "member2", model: "" },
        ],
      }
      yield* writeJsonSafe(fs, globalCouncilPath, seed)
      return { path: globalCouncilPath, seeded: true }
    })

    // -------------------------------------------------------------------------
    // Tools
    // -------------------------------------------------------------------------
    yield* ctx.tool.transform((editor) => {
      // ---- distill_session --------------------------------------------------
      editor.add({
        name: "distill_session",
        description: DESC_DISTILL,
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["run", "preview"], description: "run = score and save; preview = score only." },
            project: { type: "boolean", description: "Save under project .opencode/skills instead of global skills dir." },
            name: { type: "string", description: "Optional skill name override." },
          },
          additionalProperties: false,
        },
        execute: (raw, context) =>
          Effect.gen(function* () {
            const input = (raw ?? {}) as DistillInput
            const messages = yield* sessions
              .messages({ sessionID: context.sessionID })
              .pipe(Effect.mapError((cause) => new Tool.Error({ message: `Cannot read session: ${cause}` })))
            const stats = captureTrajectory(messages)
            const score = scoreTrajectory(stats)
            const breakdown =
              `RSI score: ${score.total}/100 (threshold ${THRESHOLD})\n` +
              `- correctness ${score.correctness} | efficiency ${score.efficiency} | coverage ${score.coverage} | reproducibility ${score.reproducibility}\n` +
              `- turns: ${stats.userTurns} user / ${stats.assistantTurns} assistant; tools: ${stats.toolCalls} calls, ${stats.toolErrors} errors, ${stats.distinctTools.length} distinct`
            if (input.action === "preview") return text(breakdown)
            if (score.total < THRESHOLD) {
              return text(`${breakdown}\n\nNot distilled: score below threshold — nothing saved.`)
            }
            const session = yield* sessions
              .get(context.sessionID)
              .pipe(Effect.mapError((cause) => new Tool.Error({ message: `Cannot read session: ${cause}` })))
            const skillName = slugify(input.name ?? session.title ?? stats.firstUserText)
            const body = yield* askSession(context.sessionID,
                  "Distill THIS session's trajectory into a reusable skill document (markdown). " +
                  "Sections: Goal, Preconditions, Steps (tool-level, concrete), Pitfalls, Verification. " +
                  "Be terse and imperative. Do not include transcript quotes or user-identifying data.",
              )
              .pipe(Effect.mapError((cause) => new Tool.Error({ message: `Skill generation failed: ${cause}` })))
            const dir = input.project
              ? path.join(projectDirectory, ".opencode", "skills", skillName)
              : path.join(global.config, "skills", skillName)
            const file = path.join(dir, "SKILL.md")
            const frontmatter =
              `---\nname: ${skillName}\ndescription: Learned skill distilled from session (RSI ${score.total}/100).\n---\n\n`
            yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.ignore)
            yield* fs
              .writeFileString(file, frontmatter + body + "\n")
              .pipe(Effect.mapError((cause) => new Tool.Error({ message: `Cannot write skill: ${cause}` })))
            return text(`${breakdown}\n\nSaved learned skill: ${file}`)
          }),
      })

      // ---- schedule_task ----------------------------------------------------
      editor.add({
        name: "schedule_task",
        description: DESC_SCHEDULE,
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["add", "list", "remove", "export"] },
            name: { type: "string", description: "Schedule name (add/remove)." },
            cadence: {
              type: "string",
              description: "5-field cron, @hourly/@daily/@weekly, or 'every N minutes/hours'.",
            },
            prompt: { type: "string", description: "What to do when due (add)." },
          },
          required: ["action"],
          additionalProperties: false,
        },
        execute: (raw, context) =>
          Effect.gen(function* () {
            const input = (raw ?? {}) as ScheduleInput
            const tasks = yield* schedules.list({ sessionID: context.sessionID })
            switch (input.action) {
              case "add": {
                if (!input.name || !input.cadence || !input.prompt)
                  return yield* new Tool.Error({ message: "add requires name, cadence, and prompt." })
                const cron = normalizeCadence(input.cadence)
                if (cron === undefined)
                  return yield* new Tool.Error({ message: `Unparseable cadence: "${input.cadence}"` })
                if (!(yield* schedules.enabled(context.sessionID)))
                  return yield* new Tool.Error({ message: "Schedule execution is disabled: enable experimental.schedules for this session's location before adding jobs." })
                if (tasks.some((task) => task.name === input.name))
                  return yield* new Tool.Error({ message: `Schedule "${input.name}" already exists; remove it explicitly before replacing it.` })
                const interval = cron.match(/^every (\d+) (minutes|hours)$/)
                const task = yield* schedules.create({
                  sessionID: context.sessionID, name: input.name,
                  when: interval ? { type: "every", every: `${interval[1]} ${interval[2]}` } : { type: "cron", cron },
                  action: { type: "prompt", prompt: input.prompt },
                })
                return text(`Scheduled "${task.name}" [${task.id}] (${cron}). Status: ${task.status}; next: ${task.nextDueAt ? DateTime.formatIso(task.nextDueAt) : "none"}. Runs through the server schedule engine.`)
              }
              case "remove": {
                if (!input.name) return yield* new Tool.Error({ message: "remove requires name." })
                const matching = tasks.filter((task) => task.name === input.name || task.id === input.name)
                if (matching.length === 0) return text(`No schedule named "${input.name}" in this session.`)
                if (matching.length > 1) return yield* new Tool.Error({ message: "Schedule name is ambiguous; use its id." })
                yield* schedules.remove(matching[0]!.id)
                return text(`Removed "${input.name}".`)
              }
              case "export":
                return text(JSON.stringify({ tasks, legacy: { path: schedulePath, active: false, data: yield* readJsonSafe(fs, schedulePath) } }, null, 2))
              case "list":
              default: {
                if (tasks.length === 0) return text(`No executable schedules in this session. Legacy JSON records, if any, are available via export and are not active.`)
                const lines = tasks.map((task) => {
                  return `- ${task.name ?? task.id} [${task.id}] | ${task.status} | next: ${task.nextDueAt ? DateTime.formatIso(task.nextDueAt) : "none"} | runs: ${task.runCount} | outcome: ${task.lastOutcome ?? "none"}`
                })
                return text(lines.join("\n"))
              }
            }
          }).pipe(Effect.mapError((cause) => cause instanceof Tool.Error ? cause : new Tool.Error({ message: `Schedule operation failed: ${cause}` }))),
      })

      // ---- council ----------------------------------------------------------
      editor.add({
        name: "council",
        description: DESC_COUNCIL,
        options: { codemode: false },
        input: {
          type: "object",
          properties: {
            question: { type: "string", description: "The question to put to the council." },
            strategy: {
              type: "string",
              description:
                "council (chairman synthesizes), compare (side by side), debate (members argue over " +
                "`rounds`, chairman resolves), moa (Mixture-of-Agents aggregate), router (chairman " +
                "picks best-suited member), consensus (members score each other; highest total wins), " +
                "arena (user picks). Aliases: synth, sidebyside, roundtable, map, route, vote.",
            },
            members: {
              type: "array",
              items: { type: "string" },
              description:
                'Inline override of the council members for this call: an array of "provider/model" strings. ' +
                "When omitted, members are read from council.json.",
            },
            rounds: { type: "number", description: "Debate rounds (debate strategy only, default 2)." },
          },
          required: ["question"],
          additionalProperties: false,
        },
        execute: (raw, context) =>
          Effect.gen(function* () {
            const input = (raw ?? {}) as CouncilInput
            const question = (input.question ?? "").trim()
            if (!question) return yield* new Tool.Error({ message: "council requires a question." })
            const strategy = STRATEGY_ALIASES[(input.strategy ?? "council").toLowerCase()] ?? "council"
            const resolved = yield* loadMembers(input.members)
            if ("error" in resolved) return yield* new Tool.Error({ message: resolved.error! })
            let members = resolved.members ?? []
            if (members.length === 0) {
              const seeded = resolved.path ? { path: resolved.path, seeded: false } : yield* seedCouncil(context.sessionID).pipe(
                Effect.mapError((cause) => new Tool.Error({ message: `Cannot seed council.json: ${cause}` })),
              )
              return text(
                `No active council members — ${seeded.seeded ? "seeded a template" : "preserved existing configuration"} at:\n${seeded.path}\n` +
                  'Add two or more "provider/model" entries, then retry. Available models can be listed via the models command.',
              )
            }
            // Validate against the live provider registry; unknown models are skipped with a note.
            const available = yield* models.available()
            const known = new Set(available.map((model) => `${model.providerID}/${model.id}`))
            const notes: string[] = []
            members = members.filter((member) => {
              if (known.has(refToString(member.model))) return true
              notes.push(`Skipped unknown model: ${refToString(member.model)}`)
              return false
            })
            if (members.length < 2)
              return yield* new Tool.Error({
                message:
                  `A council needs at least two valid members (have ${members.length}` +
                  `${notes.length > 0 ? `; ${notes.join("; ")}` : ""}). With one, use the normal task/subagent flow.`,
              })

            const ask = (member: MemberRef, prompt: string) =>
              askCouncilMember({
                parentID: context.sessionID,
                model: member.model,
                prompt,
              }).pipe(
                Effect.map((answer) => ({ member, answer }) as MemberAnswer),
                Effect.catch((cause) =>
                  Effect.succeed({ member, answer: `[${refToString(member.model)} failed: ${cause}]`, failed: true } as MemberAnswer),
                ),
              )

            const chairJson = <T>(prompt: string, schema: string, validate: (raw: string) => Checked<T>) => Effect.gen(function* () {
              let feedback = ""
              for (let attempt = 0; attempt < 2; attempt++) {
                const raw = yield* askSession(context.sessionID, `${CHAIR_SYSTEM}\n\n${prompt}\n\nReturn ONLY valid JSON: ${schema}.${feedback}`)
                const checked = validate(raw)
                if (checked.ok) return checked.value
                feedback = `\nYour previous structured result was rejected: ${checked.error} Correct it. Do not repeat the invalid format.`
              }
              return yield* new Tool.Error({ message: `Leader JSON invalid after one corrective retry.${feedback}` })
            })
            const chair = (prompt: string) => chairJson(prompt, '{"answer":"final answer text"}', validateAnswer)

            const banner = (answers: readonly MemberAnswer[]) =>
              answers
                .map((entry) => `## ${entry.member.name} (${refToString(entry.member.model)})\n${entry.answer}`)
                .join("\n\n")

            const header = notes.length > 0 ? notes.join("\n") + "\n\n" : ""

            switch (strategy) {
              case "compare":
              case "arena": {
                const answers = yield* Effect.forEach(members, (member) => ask(member, question), {
                  concurrency: members.length,
                })
                const suffix = strategy === "arena" ? "\n\n(Ask the user which answer to keep.)" : ""
                return text(header + banner(answers) + suffix)
              }
              case "router": {
                const roster = members
                  .map((member, index) => `${index + 1}. ${member.name}: ${refToString(member.model)}`)
                  .join("\n")
                const index = yield* chairJson(
                  `Pick the single council member best suited to answer the question.\n\nMembers:\n${roster}\n\nQuestion:\n${question}`,
                  '{"member":N}', (raw) => validateRoute(raw, members.length),
                )
                const chosen = members[index]!
                const answer = yield* ask(chosen, question)
                return text(
                  `${header}Routed to ${chosen.name} (${refToString(chosen.model)}).\n\n${answer.answer}`,
                )
              }
              case "moa": {
                const answers = yield* Effect.forEach(members, (member) => ask(member, question), {
                  concurrency: members.length,
                })
                const synthesis = yield* chair(
                  `Aggregate the member proposals below into one higher-quality answer (Mixture-of-Agents). Do not mention the members.\n\n${banner(answers)}\n\nQuestion:\n${question}`,
                )
                return text(header + synthesis)
              }
              case "debate": {
                const rounds = Math.min(Math.max(Math.round(input.rounds ?? 2), 1), 5)
                let answers = yield* Effect.forEach(members, (member) => ask(member, question), {
                  concurrency: members.length,
                })
                for (let round = 2; round <= rounds; round += 1) {
                  const transcript = banner(answers)
                  answers = yield* Effect.forEach(
                    members,
                    (member) =>
                      ask(
                        member,
                        `Round ${round} of a debate. Your previous position and the others' are below. Defend or revise your answer; attack weak arguments directly.\n\n${transcript}\n\nQuestion:\n${question}`,
                      ),
                    { concurrency: members.length },
                  )
                }
                const resolution = yield* chair(
                  `Resolve this debate: declare the strongest final position and justify briefly.\n\n${banner(answers)}\n\nQuestion:\n${question}`,
                )
                return text(header + resolution)
              }
              case "consensus": {
                const answers = yield* Effect.forEach(members, (member) => ask(member, question), {
                  concurrency: members.length,
                })
                if (answers.some((answer) => answer.failed)) return yield* new Tool.Error({ message: "Consensus cannot score failed candidate answers." })
                const candidates = answers.map((entry, index) => `Candidate ${index + 1}: ${entry.member.name}\n${entry.answer}`).join("\n\n")
                let feedback = ""
                for (let round = 0; round < 2; round++) {
                  const ballots = yield* Effect.forEach(members, (judge) => ask(judge,
                    `Score EACH numbered candidate 1-10. Return ONLY valid JSON: {"scores":[{"member":1,"score":8},...]}. Include every candidate exactly once; no extra fields.\n\n${candidates}\n\nQuestion:\n${question}${feedback}`),
                    { concurrency: members.length })
                  if (ballots.some((ballot) => ballot.failed)) return yield* new Tool.Error({ message: "Consensus ballot generation failed; no further voting round." })
                  const checked = ballots.map((ballot) => validateBallot(ballot.answer, members.length))
                  const errors = checked.flatMap((ballot, index) => ballot.ok ? [] : [`Judge ${index + 1}: ${ballot.error}`])
                  const scores = members.map((_, index) => checked.reduce((sum, ballot) => sum + (ballot.ok ? ballot.value.get(index + 1)! : 0), 0))
                  const ranked = answers.map((answer, index) => ({ ...answer, score: scores[index]! })).sort((a, b) => b.score - a.score)
                  if (errors.length === 0 && ranked[0]!.score !== ranked[1]!.score) {
                    const winner = ranked[0]!
                    return text(`${header}Winner: ${winner.member.name} (${refToString(winner.member.model)})\n\nScoreboard:\n${ranked.map((entry) => `- ${entry.member.name}: ${entry.score}`).join("\n")}\n\n${winner.answer}`)
                  }
                  feedback = `\nThe entire peer voting round was rejected: ${errors.length ? errors.join(" ") : "Top scores are tied; no unique winner."} Every judge must return a corrected complete JSON ballot. Previous scores are discarded.`
                }
                return yield* new Tool.Error({ message: `No valid consensus after one corrective round.${feedback}` })
              }
              case "council":
              default: {
                const answers = yield* Effect.forEach(members, (member) => ask(member, question), {
                  concurrency: members.length,
                })
                const synthesis = yield* chair(
                  `Synthesize the council answers below into one final answer. Resolve disagreements explicitly.\n\n${banner(answers)}\n\nQuestion:\n${question}`,
                )
                return text(header + synthesis)
              }
            }
          }).pipe(Effect.mapError((cause) => cause instanceof Tool.Error ? cause : new Tool.Error({ message: `Council operation failed: ${cause}` }))),
      })
    })

    // -------------------------------------------------------------------------
    // Commands — thin prompt wrappers that drive the tools above.
    // -------------------------------------------------------------------------
    yield* ctx.command.transform((editor) => {
      const relay = (template: string, description: string, name: string) =>
        editor.add({
          name,
          description,
          execute: (input) =>
            ctx.session.prompt({
              ...input.prompt,
              sessionID: input.sessionID,
              text: template.replace("$ARGUMENTS", () => input.prompt.text ?? ""),
            }),
        })
      relay(PROMPT_DISTILL, "Distill this session into a reusable learned skill (RSI).", "distill")
      relay(PROMPT_SCHEDULE, "Manage executable session schedules.", "schedule")
      relay(PROMPT_COUNCIL, "Convene a multi-model council on a question.", "council")
    })
  }),
})
