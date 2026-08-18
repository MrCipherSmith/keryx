# Flow Journal

- 2026-08-18T16:28:02.331Z - flow created
- 2026-08-18T16:29:26.428Z - task-added: T5: D1: wave executor (scheduler.ts) + ledger concurrency-safety verification (PRD R8)
- 2026-08-18T16:29:26.653Z - task-added: T6: D1: turn-loop concurrent spawn_subagent integration (agent.ts) + maxConcurrency config field
- 2026-08-18T16:29:26.864Z - task-added: T7: D2: thread finishReason out of runAgentTurn + consume in spawn-subagent-tool.ts for SubagentCompletionStatus
- 2026-08-18T16:29:27.080Z - task-added: T8: Flip requirements package status notes to implemented with runtime evidence, once D1+D2 land
- 2026-08-18T16:30:58.031Z - frozen: 12 criteria; checksum recorded
- 2026-08-18T16:30:58.221Z - started
- 2026-08-18T16:30:58.471Z - task-done: T1: Collect remaining context
- 2026-08-18T16:52:02.896Z - task-done: T5: D1: wave executor (scheduler.ts) + ledger concurrency-safety verification (PRD R8)
- T5 findings (DONE, full suite 4141 pass/1 known-pre-existing-flaky-unrelated
  `src/sac/fwk-service.test.ts`, confirmed flaky in isolation):
  - `executeWaves(tasks, waves, deps)` + `WaveExecutorDeps<TTask,TResult>` +
    `WaveExecutionError{waveIndex, failedTaskIds, causes}` added to
    `scheduler.ts`, next to `planWaves` (untouched). Uses
    `Promise.allSettled` internally (not `Promise.all`) so one rejecting
    sibling never corrupts others in the same wave; if any task in a wave
    rejects, throws `WaveExecutionError` and does NOT proceed to the next
    wave (fail-closed, since later waves may depend on this one).
  - **PRD R8 ledger race: investigated, found ALREADY SAFE BY CONSTRUCTION,
    no fix needed.** `RemainingBudgetLedger.admit()`
    (`child/ledger.ts:103-134`) is a single synchronous method — no `await`
    anywhere between its budget check and its mutation of
    remaining/admittedChildren/outstanding. `spawnSubagent()`
    (`child/orchestrate.ts:107-164`) also has no `await` between
    `spawnChild()` and `ledger.admit()`. Since JS's event loop cannot
    interleave inside a synchronous function body, concurrent callers cannot
    race between one call's check and its own decrement. Added a regression
    test (30 async callers, each yielding a different number of
    microtask/macrotask hops before calling `admit()`) in `ledger.test.ts`
    to guard against a FUTURE change accidentally introducing an `await` in
    this path.
  - Explicit PRD R9 guard: a code comment at `WaveExecutorDeps.run`'s
    definition warns future readers not to add auto-retry logic keyed off
    completion status.
  - **For T6:** must build `taskId -> TTask` lookup index-aligned with
    `wave.taskIds[i]`/`wave.reservations[i]` exactly as `planWaves` produces
    (executeWaves trusts this, only defensively guards violations). Needs a
    catch/handling story for a thrown `WaveExecutionError` at the turn-loop
    level (should be rare once T7/D2 makes ordinary child failures values,
    not throws).
  - **For T7:** no changes needed to what T5 delivered — `run`'s contract
    already documents it must not throw for ordinary child failures,
    matching D2's design.
- 2026-08-18T17:18:53.201Z - task-done: T6: D1: turn-loop concurrent spawn_subagent integration (agent.ts) + maxConcurrency config field
- T6 findings (DONE, full suite 4146 pass/0 fail — the earlier flaky
  `src/sac/fwk-service.test.ts` did not reproduce this run):
  - Detection: a reservation pre-pass over the WHOLE `calls` array (not just
    spawn calls) computes `reservationByCallId` once, in original order,
    reusing the existing `reserveToolAttempt` — the main sequential loop then
    looks these up instead of recomputing, so today's budget-reservation
    ORDER/OUTCOME is unchanged. `spawn_subagent` calls with a granted
    reservation, if ≥2, run via `runConcurrentSpawnBatch` (new) →
    `ChildTask[]` (no `dependsOn`) → T5's `planWaves`/`executeWaves` → same
    unmodified `executeCall` as the `run` callback.
  - AC3 (order preservation) holds because the main loop still iterates
    `calls` in original order and only substitutes a precomputed result for
    already-resolved concurrent calls — verified by a test that resolves the
    SECOND spawn's fake child before the first's and asserts output order is
    still first-then-second.
  - **Two disclosed trade-offs, worth reviewer attention:**
    1. A non-`spawn_subagent` call SANDWICHED between two spawn calls in one
       batch (e.g. `[spawn1, read_file, spawn2]`) has its final RESULT
       POSITION correct, but its actual `invoke()` dispatch is delayed until
       the whole spawn sub-batch settles — not truly wall-clock-interleaved
       the way today's strict sequential loop would dispatch it. Judged
       acceptable to stay within "additive branch, not a rewrite" scope;
       flagged for T7/review to confirm this judgment call.
    2. The reservation pre-pass can't know if a LATER call will be blocked by
       the untrusted-content gate (depends on an earlier call's RESULT, not
       its shape) — a call later blocked as untrusted-tainted still consumes
       a budget reservation slot when concurrent dispatch is active. Only
       matters for a batch mixing spawn_subagent concurrency with
       web_fetch/web_search untrusted content in the same turn.
  - `maxSubagentConcurrency` (not `maxConcurrency` — actual field name):
    `AgentDeps.maxSubagentConcurrency?: number`, default
    `DEFAULT_MAX_SUBAGENT_CONCURRENCY = 3` (NOT grok-build's 32 — documented
    reasoning: can't assume uniform provider rate-limit headroom). No
    env/config-file wiring yet, same (non-)state as existing
    `maxTreeDepth`/`maxChildrenPerRun` (hardcoded constants, not
    config-loaded, verified by T6).
  - `WaveExecutionError` caught generically; on failure the whole sub-batch
    degrades to explicit `isError:true` per call (never crashes the turn,
    never auto-retries — PRD R9 guard comment present).
  - **For T4 (review) especially:** verify trade-off #1's scope judgment and
    trade-off #2's budget-reservation edge case are actually acceptable, not
    just asserted acceptable by the implementer.
- 2026-08-18T17:44:21.154Z - task-done: T7: D2: thread finishReason out of runAgentTurn + consume in spawn-subagent-tool.ts for SubagentCompletionStatus
- T7 findings (DONE_WITH_CONCERNS, full suite 4153 pass/0 fail):
  - `RunAgentTurnResult{finishReason?: "budget"|"no-progress"}` — `runAgentTurn`/
    `runAgentTurnCore` now return this instead of `void`. Confirmed
    `finishReason` never reaches model-facing output (grepped every
    `history.push`/`io.on*`/`system(...)` call site).
  - `SubagentCompletionStatus` (exact 6 values) +
    `StructuredSubagentResult{status,output,isError,partial?}` added to
    `spawn-subagent-tool.ts`; `isError = status !== "Completed"` on all
    branches, fully backward-compatible per AC8 test.
  - **Concern #1 for T4:** the new "Error" status test is coupled to an EXACT
    idSeq call count within one `invoke()` (had to trigger the 10th call to
    hit the only controllable pre-existing-but-previously-untested `catch`
    path) — fragile, documented inline, will fail loudly (not silently drift)
    if a future refactor changes call count. Worth a second look at whether
    this test is testing the real contract or an implementation accident.
  - **Concern #2 for T4:** the pre-existing empty-task validation return
    (5th return point, not one of the spec's 4 named branches) was
    categorized as `status:"Error"` — implementer's interpretation, not
    explicit spec text, since `status` is a required field on every return.
    Confirm this categorization is right, not just plausible.
  - Fixed 4 pre-existing `agent.test.ts` assertions broken by D2a's
    return-type widening (`resolves.toBeUndefined()` →
    `resolves.toEqual({})`/`{finishReason:"budget"}`) — mechanical fixups,
    not scope creep, but worth a glance to confirm nothing else was silently
    weakened.
- task-done: T3, closed directly (no new subagent dispatch) — AC1-AC9/AC11
  coverage already complete incrementally across T5/T6/T7's own test files:
  `bun test` on scheduler/ledger/spawn-subagent-tool/agent.test.ts = 121
  pass/0 fail. AC10 (no auto-retry) and AC12 (docs flip) are review/T8 items,
  not runtime tests — no gap found requiring new test-writing.
- task-done: T8 (docs flip, dispatched to haiku). All 6 files in
  `docs/requirements/keryx-multi-agent-engine/` + `docs/requirements/roadmap.md`
  flipped Phase D from spec-ready to implemented, bumped 0.3.0→0.4.0 /
  0.14.6→0.14.7, with runtime evidence citations matching this journal's T5-T7
  entries. Corrected the spec's original `HarnessRunConfig.subagents.
  maxConcurrency` sketch to the actually-built `AgentDeps.maxSubagentConcurrency`
  (no config-file wiring). Both T6 trade-offs documented as accepted scope
  boundaries, not hidden. `serve-turns.route.test.ts` showed 1 fail in a
  full-suite run (EEXIST temp-dir collision, noisy stderr) but 42/42 clean in
  isolation — same class of full-suite-parallel flake as the earlier
  `sac/fwk-service.test.ts` one, unrelated to this flow's files. Re-running
  full suite once more before code-verifier/PR to confirm.
- 2026-08-18T17:44:49.735Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-18T17:53:51.586Z - task-done: T8: Flip requirements package status notes to implemented with runtime evidence, once D1+D2 land
- 2026-08-18T18:01:30.438Z - task-added: T9: Fix code-verifier finding: WaveExecutionError discards earlier-wave successes in multi-wave batches
- 2026-08-18T18:13:17.411Z - task-done: T9: Fix code-verifier finding: WaveExecutionError discards earlier-wave successes in multi-wave batches
- code-verifier ran: PASS_WITH_WARNINGS. typecheck clean, full suite 4153/0/396
  independently re-confirmed, no lint tooling, no import cycles, no dead code
  in the 3 focus areas checked. One real non-blocking LOW finding: on a
  `WaveExecutionError` in a multi-wave batch (4+ concurrent spawns, splits at
  default maxSubagentConcurrency=3), earlier-wave successes were silently
  overwritten with a generic error result.
- T9 fixed it: `WaveExecutionError<TResult>` gained
  `partialResults: ReadonlyMap<string, TResult>` (executeWaves' throw site now
  passes a snapshot of settled results); `runConcurrentSpawnBatch`'s catch
  narrows via `instanceof WaveExecutionError`, uses real results from
  `.partialResults` for every call that has one, only synthesizes the generic
  error for calls actually missing one. Regression test: 4-spawn batch splits
  into 2 waves, wave 2 throws, wave 1's 3 real results preserved, only wave
  2's failed call gets the synthesized error. `bun test scheduler.test.ts
  agent.test.ts`: 98 pass/0 fail. Full suite: 4153 pass/1 fail (known
  `sac/fwk-service.test.ts` full-suite-parallel flake, reconfirmed 24/24 clean
  in isolation) — no new regressions.
- Proceeding to T4: PR first, then review-orchestrator against the PR per
  operator's explicit sequencing instruction (implement -> PR -> review ->
  only merge+close if clean).
- 2026-08-18T18:20:34.603Z - task-added: T10: Fix review finding F-001 (major): concurrent spawn_subagent bypasses untrustedContentSeen/batchContainsUntrustedWeb gate; F-002 (minor): unguarded fallback loop
- 2026-08-18T18:27:27.856Z - task-done: T10: Fix review finding F-001 (major): concurrent spawn_subagent bypasses untrustedContentSeen/batchContainsUntrustedWeb gate; F-002 (minor): unguarded fallback loop
- PR #339 review-orchestrator ran (logic+architecture, security, parallel):
  security DONE, zero findings (independently re-verified ledger safety,
  concurrency-cap DoS resistance, status-forgery impossibility, quarantine
  isolation, finishReason non-leak — all confirmed by reading real code).
  logic+architecture DONE_WITH_CONCERNS: 1 MAJOR (F-001: concurrent branch
  never checked untrustedContentSeen/batchContainsUntrustedWeb before
  dispatching — a gated spawn_subagent was fully EXECUTED (real ledger
  admission, real provider call, real cost) then its result discarded, worse
  than trade-off #2's original "just a reservation slot" framing; also
  covers a case the trade-off didn't mention — untrustedContentSeen
  persisting from a PRIOR turn with no web call in the current batch), 1
  minor (F-002: `!plan.ok` fallback loop uncaught, unlike the executeWaves
  happy path).
- T10 fixed both: F-001 — compute
  `untrustedGateBlocksSpawns = untrustedContentSeen || batchContainsUntrustedWeb`
  before entering the concurrent branch; if true, `spawnConcurrencyCandidates`
  fall through to the existing (already-correct) sequential loop instead of
  `runConcurrentSpawnBatch` ever being called — sequential gate logic itself
  untouched. F-002 — wrapped the fallback loop body in the same try/catch
  pattern as the executeWaves path. 3 new regression tests (prior-turn
  untrustedContentSeen with no web call in-batch: `invokeCount===0`;
  same-batch web+spawn: `invokeCount===0`, genuinely never dispatched not
  just discarded; `!plan.ok` fallback throw degrades gracefully). Full suite:
  4157 pass/0 fail (up from 4153 baseline by the 3 new tests +1 flake not
  reproducing) — no regressions.
- Committing T10's fix and pushing to PR #339 for re-review before merge.
