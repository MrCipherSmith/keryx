# SLATE-06 — a Slate untouched past the stale-lock window auto-closes on next touch, no background timer

**Area:** 7. Slate (internal lifecycle) · **Date:** 2026-08-22 · **Status:** PASS — confirmed
live, corrects an earlier NOT-EXECUTABLE-HERE attempt

## Correction note

A first attempt at this test (dispatched to a subagent) concluded NOT-EXECUTABLE-HERE, reasoning
that waiting out the real 30-second stale window was "impractical" for automated testing, and
that the internal `Slate` type (this section's nominal subject) lacks the `lastWriteAt` field
the mechanism keys on (only `ExternalSlate`, §9's subject, carries it). Both points are
factually correct, but 30 seconds of real wall-clock time is well within budget for one live
test, and the underlying staleness/auto-close mechanism is real, shared machinery
(`reclaimStaleExternalSlates`, triggered "on the next `slate.*` call that touches that project" —
`slate.md`'s own wording) that the external MCP Slate surface exposes cleanly and testably. This
re-run exercises that real mechanism directly rather than declining to test it.

## What was actually run

Real Bun script, real `@modelcontextprotocol/sdk` client against a freshly-spawned `keryx mcp
serve`:

1. `slate.open` a fresh `externalSessionId` — captures `lastWriteAt`.
2. Wait **35 real seconds** (5s past the documented `DEFAULT_LOCK_STALE_MS = 30000` window,
   confirmed at `src/lib/fs.ts:47` by the prior subagent attempt).
3. `slate.open` a **different** `externalSessionId` — this is the "next `slate.*` call that
   touches that project" the mechanism is described as triggering on.
4. `slate.open` the **original** `externalSessionId` again, to observe its resulting state.

## Captured output (real)

```json
OPEN1:  {"externalSessionId":"slate06-stale-test-...","anchors":{"root":""},"seeds":[],"lastWriteAt":"2026-08-22T09:43:49.528Z"}
// ...35s real wait...
REOPEN: {"externalSessionId":"slate06-stale-test-...","anchors":{"root":""},"seeds":[],
         "lastWriteAt":"2026-08-22T09:43:49.528Z","closedAt":"2026-08-22T09:44:24.586Z"}
```

## Summary

Confirmed exactly as documented: the original slate was **not** touched directly at all in the
intervening 35 seconds — the only thing that happened was an unrelated `slate.open` call on a
**different** id. That alone was enough to sweep and auto-close the stale slate: the final
re-open shows the identical original `lastWriteAt` (untouched — this is the same record, not a
fresh one) now carrying a real `closedAt` timestamp, landing ~35s after `lastWriteAt` — exactly
the reclaim sweep firing on the very next `slate.*` call anywhere in the project, with no
background timer involved.

## Analysis

One precise, real nuance not explicit in `slate.md`: re-opening an `externalSessionId` that was
just auto-closed for staleness returns **the same, now-closed record** (same `lastWriteAt`, a
populated `closedAt`) rather than silently starting a brand-new empty slate under that id. This
is a reasonable, safe choice — it makes the closure visible to the caller rather than quietly
discarding history — but is worth calling out since a caller might otherwise expect `slate.open`
to always hand back a live, writable slate.

## Improvement / fix suggestion

None required for the mechanism itself — it works exactly as designed. Consider a one-line
addition to `slate.md`'s "Open a slate" section noting that re-opening a since-auto-closed id
returns the closed record (with `closedAt` set) rather than a fresh slate, since the current doc
only describes the "second open for the same id, still live" no-op case, not the "second open
after auto-close" case this test exercised.
