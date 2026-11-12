# Implementation Plan

Status: draft (flow-init skill fills this after context and brainstorm)

## Approach

Investigate first, then fix at the layer where delivery is lost. The spawn tool already has `invokeWithBackstop` (child deadline + 3 min grace), so a 2h hang points at a layer outside that wrapper or at a version/branch gap. Reproduce with an injected hanging child in a 9-wide parallel batch, then add a bounded wait at the lowest layer that owns the hang rather than another timer on top.

## Steps

1. Confirm whether v0.4.26 contains `invokeWithBackstop` (history of spawn-subagent-tool.ts) and whether the factory wrapper (~line 2906) covers every return path (native, external, routing-v2 branches).
2. Read how the agent loop executes a batch of parallel tool calls (Promise.all / allSettled, trust-mode approval, PreToolUse/PostToolUse/SubagentStop hooks) and where a never-settling promise would park the turn with no timers or sockets.
3. Inspect `foldChildSlateAndCleanup`, the `save_result_to` writer, the fleet event bridge and TUI result delivery for unbounded awaits.
4. Write `spawn-subagent-parallel-hang.test.ts` reproducing the lost result in a 9-call batch (short cap / fake clock).
5. Fix at the owning layer: the stuck call resolves as Timeout, the other 8 results are delivered, `save_result_to` output stays intact.
6. Run backstop/spawn tests and typecheck; record a known-mistake memory if the root cause is a reusable lesson.

## Risks

- The hang was seen once; reproduction is approximated. Mitigation: inject hanging promises at each suspect layer.
- A second watchdog could double-fire or abort a legitimately long child (timeout_ms up to 30 min). Mitigation: derive any new bound from `resolveSubagentHardCapMs`.
- The reporter's evidence files (journal, slate.json, sample) are not in the repo; which of the 9 calls hung is unverified.
