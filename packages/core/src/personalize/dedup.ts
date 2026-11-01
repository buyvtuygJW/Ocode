// ============================================================================
// PERSONALIZATION (deltav11) — duplicate guards.
// Deterministic detection of the two provable waste shapes:
//   1. call echo: adjacent identical tool calls inside one step
//   2. prose echo: adjacent duplicate sentences inside one text part
// Hard punishment only where waste is provable (adjacent identical);
// everything contextual is counted in the ledger, never blocked.
// Pure module: no imports, no effects — unit-tested in .personalize/dedup.test.mjs.
// ============================================================================

export interface LedgerEntry {
  readonly calls: number
  readonly prose: number
  readonly wastedTokens: number
}

const ledgers = new Map<string, LedgerEntry>()

export function resetLedger(): void {
  ledgers.clear()
}

export function ledgerState(key: string): LedgerEntry | undefined {
  return ledgers.get(key)
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

export function bumpLedger(key: string, kind: "calls" | "prose", wastedTokens: number): LedgerEntry {
  const entry = ledgers.get(key) ?? { calls: 0, prose: 0, wastedTokens: 0 }
  const next: LedgerEntry = {
    calls: entry.calls + (kind === "calls" ? 1 : 0),
    prose: entry.prose + (kind === "prose" ? 1 : 0),
    wastedTokens: entry.wastedTokens + wastedTokens,
  }
  ledgers.set(key, next)
  return next
}

/** Cumulative punch line, injected once the session has two or more duplicates total. */
export function punchLine(entry: LedgerEntry | undefined): string {
  if (!entry) return ""
  const total = entry.calls + entry.prose
  if (total < 2) return ""
  return `\n*SystemPunch* duplicates this session: ${total} (≈${entry.wastedTokens} tkn wasted)`
}

// --- guard 1: call echo ------------------------------------------------------

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`
}

/** Signature of one tool call; calls differing only in argument key order collide by design. */
export function callSignature(name: unknown, args: unknown): string {
  return `${String(name ?? "")}(${stableStringify(args)})`
}

export function slapReceipt(callNumber: number, wastedTokens: number, punch: string): string {
  return `*Systemslap* DUPLICATE of call #${callNumber} this turn — result already in context. wasted: ~${wastedTokens} tkn${punch}`
}

// --- guard 2: prose echo -----------------------------------------------------

/** Sentences shorter than this (normalized) are structural noise — never compared. */
const MIN_SENTENCE_CHARS = 24

export function normalizeSentence(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim()
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
}

export interface DedupeTextResult {
  readonly text: string
  readonly removed: number
  readonly wastedTokens: number
}

/**
 * Strips runs of adjacent duplicate sentences from ONE text part. The first
 * occurrence is kept, each stripped run leaves one inline marker. Everything
 * else — short sentences, non-adjacent repeats, cross-part or cross-turn
 * repetition — is deliberately left alone.
 */
export function dedupeText(text: string): DedupeTextResult | undefined {
  if (text.length < MIN_SENTENCE_CHARS * 2) return undefined
  const sentences = splitSentences(text)
  if (sentences.length < 2) return undefined
  const out: string[] = []
  let removed = 0
  let wastedTokens = 0
  let changed = false
  let index = 0
  while (index < sentences.length) {
    const kept = sentences[index]!
    out.push(kept)
    const normalized = normalizeSentence(kept)
    let run = 0
    while (
      index + 1 + run < sentences.length &&
      normalized.length >= MIN_SENTENCE_CHARS &&
      normalizeSentence(sentences[index + 1 + run]!) === normalized
    ) {
      run++
    }
    if (run > 0) {
      changed = true
      removed += run
      wastedTokens += run * estimateTokens(kept)
      const preview = kept.length > 60 ? `${kept.slice(0, 60)}…` : kept
      out.push(`[duplicate removed ×${run}: "${preview}"]`)
      index += run
    }
    index++
  }
  if (!changed) return undefined
  return { text: out.join(" "), removed, wastedTokens }
}
