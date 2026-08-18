# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: N sibling `spawn_subagent` calls in one turn, each backed by an
  injected fake child with a distinct artificial delay, complete in
  wall-clock time bounded by `max(delays)`, not the sum — proven by a
  deterministic test (fake/injected clocks, no real `setTimeout` sleep).
  Matches PRD SC7/spec AC9.
- AC2: Concurrency never exceeds the configured `maxConcurrency`, and the
  aggregate budget ledger never over-grants across concurrently-running
  children — property test extending the existing sequential-spawn AC3
  coverage to concurrent grants. Matches PRD SC7/spec AC10.
- AC3: Results for a batch of concurrent `spawn_subagent` calls are spliced
  back to the model in the ORIGINAL call order, independent of which child
  actually finished first (dedicated test — completion order and reporting
  order deliberately decoupled in the test fixture to catch an off-by-one).
- AC4: Tool calls of non-`spawn_subagent` types in the same batch as one or
  more `spawn_subagent` calls keep today's exact sequential dispatch order
  and timing — regression test proving D1 is additive, not a rewrite of the
  whole loop.
- AC5: A child whose own step/tool-call budget exhausts before a clean finish
  returns `status: "BudgetExhausted"`, never `status: "Completed"` nor bare
  `isError:false`. Matches PRD SC8/spec AC11.
- AC6: A child hitting the existing no-progress detector returns
  `status: "NoProgress"`, distinct from `"BudgetExhausted"`. Matches spec
  AC11.
- AC7: Existing `Timeout`/`Denied`/`Error` paths keep their current
  `isError:true` behavior and gain the matching `status` value, with no
  regression to how those cases were already handled pre-Phase-D (regression
  test against the existing timeout/error/denial test cases).
- AC8: A caller/dispatch shape that never reads the new `status` field
  behaves identically to pre-Phase-D Keryx — full backward compatibility
  (regression test mirroring the A→B→C engine's own AC7 pattern). Matches
  spec AC12.
- AC9: `RemainingBudgetLedger`'s grant/decrement step is confirmed (by reading
  the code, not by assumption) to have no `await` between the remaining-budget
  check and the decrement, so concurrent grants introduced by D1 cannot race
  past the shared remaining budget (PRD R8) — documented finding either way in
  the flow journal, with a fix if the concern turns out to be real.
- AC10: No mechanical auto-retry logic is added anywhere in the harness keyed
  off the new `SubagentCompletionStatus` values — the status is advisory for
  the orchestrator model's own judgment only (PRD R9). Verified by review, not
  a runtime test.
- AC11: Full `bun test` suite and `bun run typecheck` stay green; no
  regression outside the touched files (`scheduler.ts`, `agent.ts`,
  `spawn-subagent-tool.ts`, and their test files).
- AC12: Once AC1-AC11 hold, the requirements package
  (`docs/requirements/keryx-multi-agent-engine/`) status notes are flipped
  from "specification-ready, not implemented" to "implemented" with concrete
  runtime evidence (file:line + test file references), matching how A→B→C's
  own status notes cite flows 088-101.
