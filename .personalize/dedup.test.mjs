import { test } from "node:test"
import assert from "node:assert/strict"
import {
  bumpLedger,
  dedupeText,
  estimateTokens,
  ledgerState,
  normalizeSentence,
  punchLine,
  resetLedger,
  splitSentences,
} from "../packages/core/src/personalize/dedup.ts"

test("punch line appears only from the second duplicate onward and counts both kinds", () => {
  resetLedger()
  assert.equal(punchLine(ledgerState("s1")), "")
  bumpLedger("s1", "calls", 10)
  assert.equal(punchLine(ledgerState("s1")), "")
  bumpLedger("s1", "prose", 30)
  assert.match(punchLine(ledgerState("s1")), /\*SystemPunch\* duplicates this session: 2 \(≈40 tkn wasted\)/)
  assert.equal(ledgerState("nope"), undefined)
  resetLedger()
  assert.equal(ledgerState("s1"), undefined)
})

test("dedupeText strips adjacent duplicate sentences, keeps the first, leaves a marker", () => {
  const text = "Build finished with exit zero. Build finished with exit zero. Now running the serve test."
  const result = dedupeText(text)
  assert.ok(result)
  assert.equal(result.removed, 1)
  assert.match(result.text, /\[duplicate removed ×1: "Build finished[^"]*"\]/)
  assert.ok(result.text.includes("Now running the serve test."))
  assert.ok(result.wastedTokens > 0)
  const withoutMarker = result.text.replace(/\[duplicate[^\]]*\]/, "")
  assert.ok(!withoutMarker.includes("Build finished with exit zero. Build"))
})

test("dedupeText collapses longer runs into one marker", () => {
  const text = "Alpha beta gamma delta epsilon. Alpha beta gamma delta epsilon. Alpha beta gamma delta epsilon."
  const result = dedupeText(text)
  assert.ok(result)
  assert.equal(result.removed, 2)
  assert.match(result.text, /×2/)
})

test("dedupeText leaves non-adjacent repeats, short sentences and healthy text alone", () => {
  assert.equal(dedupeText("Just one sentence, nothing repeated here at all."), undefined)
  assert.equal(dedupeText("Fine. Fine. Fine. Fine. Fine. Fine. Fine. Fine. Fine. Fine."), undefined)
  const nonAdjacent =
    "Alpha beta gamma delta epsilon zeta. A completely different sentence follows here. Alpha beta gamma delta epsilon zeta."
  assert.equal(dedupeText(nonAdjacent), undefined)
})

test("sentence normalization ignores case, punctuation and whitespace", () => {
  assert.equal(normalizeSentence("  Build, FINISHED!!  "), normalizeSentence("build finished"))
  assert.deepEqual(splitSentences("One. Two!\nThree?"), ["One.", "Two!", "Three?"])
})

test("estimateTokens is a deterministic chars/4 ceiling", () => {
  assert.equal(estimateTokens("1234"), 1)
  assert.equal(estimateTokens("12345"), 2)
})
