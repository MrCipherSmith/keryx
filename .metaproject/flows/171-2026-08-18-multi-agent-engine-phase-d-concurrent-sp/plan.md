# Implementation Plan

Status: adopted from `docs/requirements/keryx-multi-agent-engine/implementation-plan.md`'s
Phase D section — architecture already resolved, adversarially reviewed before
this flow opened.

## Approach

Two additive slices to the already-shipped A→B→C multi-agent engine. No rework
of shipped contracts (model resolution, budget/policy inheritance, D-02).
Sequenced so D1 (concurrency) lands with a genuinely clean-slate dispatch order
before D2 (status) changes what gets returned on each of those dispatches —
doing it in the other order would mean re-testing D2's status paths under both
sequential and concurrent execution.

## Steps

1. **D1a — Wave executor** (`src/harness/parallel/scheduler.ts`): add
   `executeWaves(tasks, waves, deps)` next to the existing `planWaves`. Pure
   wave-order enforcement, concurrent-within-wave via `Promise.all`; a
   rejected child settlement must not abort its siblings — use
   `Promise.allSettled` internally if `deps.run` itself can reject, even
   though D2's contract makes rejection unlikely for the intended caller
   (failures become status values, not thrown errors). `planWaves` itself is
   not modified.
2. **D1b — Turn-loop integration** (`src/commands/agent.ts`, ~line 1192-1238):
   detect 2+ `spawn_subagent` calls in the same tool-call batch, build
   `ChildTask[]` (no `dependsOn` — same-turn siblings are independent by
   construction), call `planWaves` with the new `maxConcurrency` config
   value, run `executeWaves`, splice results back into the batch's per-call
   results in the model's ORIGINAL call order (concurrency changes execution
   order, never reporting order — the model must not be able to tell from
   result ordering that anything ran concurrently). Every other tool type in
   the same batch keeps today's sequential path untouched.
3. **D1c — Config field**: `HarnessRunConfig.subagents.maxConcurrency` (new,
   optional, conservative default — implementer picks the number; not fixed
   by the spec, informed by but not copying grok-build's 32-default, since
   Keryx cannot assume the same provider-side rate-limit headroom for every
   configured provider/local-model combination). Threaded the same way
   `maxTreeDepth`/`maxChildrenPerRun` already are.
4. **Verify the ledger race concern (PRD R8) explicitly** before/alongside D1b:
   confirm `RemainingBudgetLedger`'s grant/decrement step has no `await`
   between check and decrement (so concurrent grants under D1's new
   concurrent execution cannot race past the shared remaining budget) — read
   the actual code, don't assume the existing sequential tests already prove
   this for the concurrent case.
5. **D2a — Thread the internal finish reason out** (`src/commands/agent.ts`):
   `runAgentTurn`'s return value gains an internal (not model-facing)
   `finishReason?: "budget" | "no-progress"` field, set exactly where
   `finishWithBudgetSummary` (~line 1349) and the existing no-progress
   detector (~line 1318) already fire. No new detection logic — surfacing
   what's already computed internally.
6. **D2b — Consume it in the tool** (`src/harness/tool/builtin/spawn-subagent-tool.ts`):
   the success-path branch (~line 844-872) checks the child turn's
   `finishReason` before building its return value — `"budget"` →
   `status:"BudgetExhausted"`, `"no-progress"` → `status:"NoProgress"`,
   otherwise `status:"Completed"`. Existing timeout branch (~812-840) gains
   `status:"Timeout"`; thrown-error branch (~873-888) gains `status:"Error"`;
   the MAE-denial branch (`spawned.ok === false`) gains `status:"Denied"`.
   `isError` stays derived (`true` for every non-`Completed` status) for
   backward compatibility — a caller reading only `{output, isError}` sees no
   behavior change.
7. **Tests**: `scheduler.test.ts` extension (AC9 — N fake children with
   distinct injected delays complete in `max(delays)` wall-clock time, no real
   sleep; AC10 — concurrent grants against the shared ledger never exceed
   parent remaining, extending AC3's existing property test to interleaved
   calls); `spawn-subagent-tool.test.ts` extension (AC11 — one test per status
   value, especially the two net-new ones); `agent.test.ts` extension (AC12 —
   a caller that never reads `status` behaves identically to pre-Phase-D,
   regression-style, mirroring how AC7 proved backward compatibility for the
   A→B→C model-selection work).
8. **Docs**: this flow's own requirements package
   (`docs/requirements/keryx-multi-agent-engine/`) is already updated to
   spec-ready — once implemented, its status notes (README/prd/spec/
   implementation-plan/agent-protocol, all currently "specification-ready,
   not implemented" for Phase D) need a follow-up pass to flip to
   "implemented" with runtime evidence, same pattern as A→B→C's own status
   notes. Track as a task in this flow, not deferred silently.

## Risks

- PRD R8 (ledger race under real concurrency) — see step 4; this is the one
  place where "reuse existing tested code" could be a false sense of safety,
  since the existing tests never exercised concurrent grants.
- PRD R9 (status enum invites mechanical auto-retry) — the implementer must
  not add harness-driven auto-retry logic keyed off the new status values;
  they are advisory for the orchestrator model's own judgment only. Flag this
  explicitly in code comments at the point the status is returned, so a future
  reader doesn't "helpfully" add auto-retry later.
- Splicing concurrent results back into original call order (step 2) is easy
  to get subtly wrong (off-by-one, wrong index after a `Promise.all` settles
  out of submission order) — needs a dedicated test asserting result order
  independent of completion order, not just correctness of each result.
