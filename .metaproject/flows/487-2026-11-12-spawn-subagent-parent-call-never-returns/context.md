# Context

Collected deterministically by `keryx flow init` at 2026-11-12T09:32:48.876Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

1. [1.69] keryx-gdctx-gdgraph-routing-index-cost-not-measured-before-shipping (known-mistake/accepted) - known-mistakes/keryx-gdctx-routing-index-cost-not-measured-before-shipping.md
   A mandatory context-injection rule's per-read cost multiplies by every subsequent turn and every subagent dispatch. Measure the re-billed cost across a realistic turn count and subagent fan-out before setting a rule's default scope, not just its one-time size.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:context, orchestration, keryx-cli, subagent-dispatch, entity:hard-gate rule, transcript re-sending, subagent-context-assembly, orient-runtime
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-5) and docs/requirements/keryx-context-measurement/context-loading.md author=unknown confirmedBy=Measured in context-loading.md: 41,556→42,133 tokens across 4 turns with full index re-billing
2. [1.657] gdctx-redaction-ignores-trust-tag (known-mistake/accepted) - known-mistakes/gdctx-redaction-ignores-trust-tag.md
   A `SecuritySource` tag (`trusted-project`) can be threaded all the way to a redaction call and still have zero effect on the policy outcome if the resolver only branches on `category`. Verify a trust axis actually changes a decision before shipping the tag, not just that the tag is present in the type.
   claimType: known-mistake | confidence: high | version: 0.1.0
   scope: module:security, redaction, policy-resolution, entity:resolveDecision, buildFinding, SecuritySource, policyFor, image-url policy
   provenance: source=flow 320 (W7 gdgraph/gdctx correctness) link=docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-2) author=unknown confirmedBy=Reproduced this session via `keryx ctx read README.md --mode full`
3. [1.633] A fix round needs its own review: three consecutive rounds each introduced a blocker (lesson/accepted) - lessons/a-fix-round-needs-its-own-review-three-consecutive-rounds-each-introduced-a-blocker.md
   On PR #215 (flow 127, project registry) three consecutive review-fix rounds each introduced a new blocker while closing the previous one. The defect was not in any single fix; it was in treating a fix as finished once it addressed the reported symptom.
   claimType: lesson | confidence: high | version: 0.5.0
   scope: module:core, entity:project-registry
   provenance: source=review rounds on PR #215 (flow 127), PR #216 (flow 128), PR #220 (flow 133) link=https://github.com/MrCipherSmith/keryx/pull/215 author=unknown confirmedBy=unknown
4. [1.615] OpenTUI: alignSelf on a transcript box collapses its intrinsic height (lesson/accepted) - lessons/tui-alignself-height-collapse.md
   In a `@opentui/core` ScrollBox column, a child `BoxRenderable` carrying `alignSelf: "flex-start"` stops measuring its intrinsic HEIGHT: it collapses to the viewport height, squeezes its children, and makes the ScrollBox under-report `scrollHeight`. Hug content with `maxWidth` instead.
   claimType: lesson | confidence: high | version: 1.0.0
   scope: module:tui, entity:transcript-blocks, shell-chrome
   provenance: source=flow 115 link=.metaproject/flows/115-2026-07-21-tui-dim-collapsible-thought-blocks-fix-a author=unknown confirmedBy=unknown
5. [1.583] Flow ids are allocated per clone, not per checkout (constraint/accepted) - constraints/flow-ids-allocated-per-clone.md
   `flow init` reserves its number in the git common directory, so every linked worktree of one clone shares the id space. A number, once handed out, is never reused — not even after the flow directory is deleted or renumbered.
   claimType: constraint | confidence: high | version: 1.0.0
   scope: module:tasks, entity:flow
   provenance: source=flow 116 (fix duplicate flow ids) link=.metaproject/flows/116-2026-07-22-fix-duplicate-flow-ids-nextflowid-races- author=unknown confirmedBy=unknown

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: pass (as of 2026-10-06T09:19:55.947Z)
- refresh: `keryx health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdskills
- memory
- tasks
- health
- testing
- gdwiki
- security
- mcp

## Agent Findings

_(flow-init skill appends here)_

### Step 1 findings (2026-11-12) — NOT yet a confirmed root cause

Existing bounds on a `spawn_subagent` call (all predate the report):
1. `invokeWithBackstop` — `src/harness/tool/builtin/spawn-subagent-tool.ts:569`, applied to the whole tool by the factory's last line (~2906). Cap = child deadline + 3 min, about 8 min for `timeout_ms` 300000. Added in 6bd22fbcf (2026-10-10, 0.3.100). Cap 0 (no bound) for `runtime.kind=external` or `KERYX_SUBAGENT_TIMEOUT_MS=0`.
2. `runWithCallWatchdog` — `src/commands/call-watchdog.ts`, wired in `src/commands/agent.ts` `executeCallTraced` for `spawn_subagent` only. Default 12 min (`KERYX_SPAWN_CALL_WATCHDOG_MS`; 0 disables). Added 07430ae20 (0.3.101), hardened fcb9e3c33 (0.3.102, `KERYX_PHASE_TRACE`).
   - KEY: `HUMAN_STAGES = {"approval"}`: while the call's stage is `approval` the timer re-arms forever (no bound by design). `mark("approval")` is set in `executeCallUnbounded` (agent.ts ~6071) only when the call is NOT auto-approved (hook `ask` / untrusted origin etc.).
3. Parallel path: `agent.ts` `runConcurrentSpawnBatch` (~5415) -> `planWaves`/`executeWaves` (`src/harness/parallel/scheduler.ts:274`, `Promise.allSettled` per wave) -> `executeCall` (watchdogged). The turn awaits the WHOLE batch before pushing any tool result / trail / archive entry (explains: no trail steps for w2).

Implication: a stall inside `invoke` should be cut at ~8 min (1) and ~12 min (2). The report says 2h+, so the stall is outside both, or one was disabled/suspended. Hypotheses, in test order:
- H1: one call of the batch sits in stage `approval` (hook `ask` / untrusted origin; approval prompt never rendered or lost under concurrent calls; TUI unresponsive). The watchdog deliberately never fires and `executeWaves` waits for it. Matches: 9 auto-approved rows + 1 `running` row, UI unresponsive, no timeout. Check `src/tui/tui-shell.ts` `requestApprovalLocally` (~6417) / `trackApproval` with N concurrent calls.
- H2: stall AFTER the watchdog answers (post-batch: spill, `recordSlateSessionTrail`, slate/archive lock shared with the child fold, hooks). slate.json mtime == last model call hints that the child fold touched slate at the end.
- H3: watchdog/backstop disabled by env, or external-runtime path (cap 0).

Caveats:
- Local `package.json` is 0.4.11 while the report says 0.4.26: verify this checkout matches the reporter's build.
- The reporter's journal / slate.json / process sample are not in the repo; a re-run with `KERYX_PHASE_TRACE` would show the stuck stage.

### Step 1 findings, part 2 (2026-11-12)

Verified in code (no defect found in these layers):
- `executeWaves` (`scheduler.ts`): `Promise.allSettled` per wave, no extra waiting. Not the stall.
- `invokeWithBackstop` (`spawn-subagent-tool.ts:569`): timer is armed before `invoke`, raced, cleared only in `finally`. Sound. Cap 0 only for `runtime.kind=external` or `KERYX_SUBAGENT_TIMEOUT_MS=0`.
- `runWithCallWatchdog`: sound except `HUMAN_STAGES={"approval"}` (re-arms forever) and `capMs<=0` (`KERYX_SPAWN_CALL_WATCHDOG_MS=0`).
- `runConcurrentSpawnBatch.runOne` always passes `untrustedOrigin=false`; `next[18]=stage` is wired to the right parameter.
- The post-batch loop (`agent.ts` ~4540-4690) writes `onToolResult`, spill and `recordSlateSessionTrail` per call, in order. The reported absence of w2 trail steps places the stall INSIDE the batch await, before the loop. Post-batch stall (H2) is unlikely.

Narrowed conclusion: with default env, only stage `approval` evades both timers (executeCall sets it only in the ask branch, `agent.ts` ~6071). The TUI approver (`tui-shell.ts` `requestApprovalLocally` ~6417) handles an asked `spawn_subagent` by a read_only fast path (`shouldAutoApproveReadOnlySpawn`, ~1657) or, for `general` / hookAsk / untrusted, by a modal in the SINGLE shared `chrome.dock` (`showComposerChoice`, ~6475). N concurrent asks from one batch all target that one dock; a lost or unanswered dock promise leaves the call in `approval` and the watchdog never fires. Not yet proven: whether concurrent `showComposerChoice` calls on one dock are serialized or clobber each other.

Next (step 2 of the plan): (a) read `showComposerChoice` / `chrome.withOverlay` for concurrency; (b) write `spawn-subagent-parallel-hang.test.ts` with a batch of 9 where one `requestApproval` never settles; (c) ask the reporter for env (`KERYX_SPAWN_CALL_WATCHDOG_MS`, `KERYX_SUBAGENT_TIMEOUT_MS`) and a `KERYX_PHASE_TRACE` log.

### Step 2a: dock concurrency (2026-11-12)

`src/tui/composer-choice.ts` (read around `lockDock`, ~275, and `showComposerChoiceDetailed`, ~327):
- Concurrent choices on one dock are NOT clobbered. They are serialized by `lockDock` (a promise chain, `dockChain`), so 9 asks queue behind one another. `presentComposerChoice` also has a reentrancy guard (`dock.visible`) that answers `cancelId` immediately. This rules out part of H1: the dock does not lose promises by overlap.
- Remaining gap: a queued ask waits in `await lockDock(dock)` with no timeout. The request `signal` is checked only AFTER the lock is acquired, and the abort listener is attached only inside `presentComposerChoice`. A queued approval therefore ignores a turn abort and stays in stage `approval` while the holder in front of it stays open. That stage suppresses the call watchdog (`HUMAN_STAGES`).
- This does not fully explain the report: in trust mode the 9 children were auto-approved (read_only fast path, no dock), so a dock queue should not have formed. Dock-queue stall is a secondary candidate, not the root cause.

Still unresolved: no path found that evades both timers with default env. Next: the regression test `spawn-subagent-parallel-hang.test.ts` (a batch of 9, one never-settling call; expected: the turn returns via the watchdog or backstop); request env and a `KERYX_PHASE_TRACE` log from the reporter.

### Step 2b: regression test (2026-11-12)

`src/harness/tool/builtin/spawn-subagent-parallel-hang.test.ts`, 4 tests, all pass together with `spawn-subagent-backstop.test.ts` and `call-watchdog.test.ts`: a batch of 9 with one child hung inside `invoke` (backstop answers), a stall outside `invoke` (call watchdog answers), both layers together, and a call parked at stage `approval` freed by the operator's abort. It is a regression guard for AC2/AC5, NOT a reproduction: the guards work in isolation.

### Step 3: checkout vs v0.4.26 (2026-11-12)

- Local HEAD `2caa22985` (`v0.4.11-4`) is an ancestor of tag `v0.4.26`: the checkout is behind the reporter's version.
- At v0.4.26 the guards are structurally the same: `invokeWithBackstop` (spawn tool 562, wrapper 2787), `runWithCallWatchdog` (agent.ts 5728), `HUMAN_STAGES = {approval}`, same env cap. `call-watchdog.ts` and `scheduler.ts` have no diff.
- What changed in HEAD..v0.4.26 near this path: flow 486 (`hc run` approval floors, dialog paste guard: `onPaste`, `onSelectReady`, held pastes in `composer-choice.ts`; `tui-shell.ts` +840 lines), routing v2 removal in the spawn tool, and `untrustedContentSeen ||= holdsExternalReport(...)` in `agent.ts` (bus drains ~4184, ~4832). When `untrustedContentSeen` is true the concurrent batch is skipped (~4429) and spawns go through the sequential per-call loop with approval.
- The report shows a concurrent batch of 9, so the sequential-approval path does not match it. Not yet verified: the new dialog paste guard in a queued state, and the routing classification step before the child deadline starts (inside `invoke`, so the backstop should still cover it).

## Diagnostics (step 4, added after the user asked for logs/metrics for the next hang)

The root cause is still unproven, so the next occurrence must explain itself. Always-on, no env flag needed:

- `src/lib/call-diagnostics.ts`: registry of in-flight tool calls (callId, name, stage, startedAt, stageSince), bounded ring buffer of the last phase events, counters, a stall watcher (default tick 30s; a call sitting in one stage past the limit is dumped once, again only after the repeat window; event-loop lag recorded), and probes read at snapshot time (composer dock, env caps). Output: one JSON line per dump under `<config>/diagnostics/<session>.ndjson`, created on first dump, size-capped.
- Feed: `tracePhase` writes into the ring; `call-watchdog.ts` labels carry the call id (9 concurrent calls no longer interleave); `agent.ts` executeCall registers every call and reports stage changes; `invokeWithBackstop` reports armed/expired/settled.
- Probes: `composerDockDiagnostics()` in `src/tui/composer-choice.ts` (holders, waiting, holder age, oldest wait) answers the lockDock-queue hypothesis (H4) directly.
- Operator: `/diag` (`src/tui/diag-command.ts`) dumps the snapshot on demand, also in the readline shell; listed in help groups and `docs/docs/commands-by-task.md`.
- What to read after a hang: the last `diagnostics/<session>.ndjson` line: a call stuck in stage `approval` with `dock.waiting > 0` and a large `holderAgeMs` confirms the dock-queue hypothesis; a call in `invoke` with no backstop event points at the backstop timer; an empty file with a stuck UI points at event-loop starvation (see the lag field).
- Tests: call-diagnostics.test.ts, diag-command.test.ts, composer-choice.test.ts (dock diagnostics), call-watchdog.test.ts, spawn-subagent-parallel-hang.test.ts. tsc clean.
- Auto-dump on interrupt: `maybeDumpOnInterrupt()` (`src/tui/diag-command.ts`) writes a snapshot before the turn is cancelled when a call has sat 60s in one stage or 5min in flight. Wired at Ctrl+C (cancel-turn) and `/interrupt` in `tui-shell.ts`. Esc does not cancel a main turn in this shell, so it is not wired; the readline shell dumps in `makeSignalShutdown` (`beforeAbort`, shell.ts) on SIGINT/SIGTERM/SIGHUP, printing the note to stderr. Test in diag-command.test.ts.
- Not done: probes for permission mode / untrustedContentSeen; hardening (abortable queued lockDock, bounded approval stage) waits for evidence.
