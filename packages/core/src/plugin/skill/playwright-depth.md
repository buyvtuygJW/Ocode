# Playwright snapshot depth

A full-depth `browser_snapshot` on a busy page is the most expensive single call in a
browser session. Depth-limit it, and remember the depth that worked per site so the
second visit is cheap.

## Observed cost (one busy docs page)

| call | tokens |
|---|---|
| `browser_navigate` | ~80 — returns a snapshot **file link**, not the tree |
| `browser_snapshot` full depth | **~8,676** — worst case |
| `browser_snapshot` depth=3 | ~600 — 14x cheaper |
| `browser_take_screenshot` | ~969, inline PNG — quiet, looks harmless, is not |
| `browser_network_requests` / `browser_console_messages` | 10–20 — bulk suppressed |

Full depth costs roughly **14x** depth=3. One careless snapshot is worth fourteen
careful ones. Treat these as the right order of magnitude, not a guarantee.

## Memory file

`{{CACHE_PATH}}`

```json
{ "example.com": { "depth": 3, "anchor": "main", "hits": 2, "updated": "2026-10-04" } }
```

Keyed by hostname only — no scheme, no path. `anchor` records the container the useful
content sat under, so the next visit can go straight there. Create the file with `{}`
if it does not exist.

## Protocol

1. **Before** the first snapshot of a hostname, read the memory file.
2. **Hit** → snapshot at the stored depth. State the five-word hint, verbatim:
   `cached depth=N, escalate if missing`
3. **Miss** → start at `depth=3`. Never open above 3 on a first visit.
   Hint: `no cache, starting depth=3`
4. **Escalate only on failure**, one step at a time: 3 → 5 → full. "Failure" means the
   node you actually need is absent — not that the tree merely looks small.
5. **Write back** the depth that worked, incrementing `hits`. A site that genuinely
   needed full depth is worth recording too: that is a real finding, not a failure.
6. Prefer the file link `browser_navigate` already returned over re-snapshotting.
   Prefer `browser_console_messages` / `browser_network_requests` over a screenshot
   when you only need to know *state*.

## Do not

- **Do not truncate, cap, or post-process snapshot output.** Depth is the only lever
  here. A capped snapshot silently drops the node you were looking for and costs a
  retry, which is worse than the tokens it saved.
- Do not write a cache entry for a site you have not actually snapshotted. An invented
  depth is worse than no entry, because the next run will trust it.
- Do not escalate straight from 3 to full. The 5 step resolves most misses.

## If `depth` is rejected

Tool names and parameters follow `@playwright/mcp`. If your server's `browser_snapshot`
exposes no `depth` parameter, narrow by `ref`/selector to the subtree you need instead
and record that selector as `anchor` — the memory protocol above is unchanged.
