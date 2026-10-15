# Context — Flow 014 (W11 flow integration)

Collected by `keryx flow init` and enriched for W11. (T1 context.) Release 1.

## Baseline
- `bun test` = 899 pass / 0 fail; `tsc --noEmit` clean; deps `{}`. Branch @ 8ed5373.

## Build on (reuse — do NOT rewrite; src/flow only ADDITIVE)
- W2 `src/flow/{types,service,store,machine}.ts`: `FlowService` (init/list/get/freeze/start/taskAdd/**taskDone(disposition)**/acConfirm/acUpdate/implemented/complete/block/unblock/check); `FlowTask` additive fields (dependsOn/attempts/disposition/acRefs/**evidenceRefs**/budget/**runLink**); `TaskDisposition`, `TaskRunLink`; read-time v1→v2 migration (`migrateFlow`). Task Manager is the SOLE flow.json writer (writeFlow only in src/flow save/init).
- W7 `src/harness/completion/gate.ts` (`CompletionGateResult`, `evaluateCompletion`, `CompletionCheck`), `src/harness/evidence/types.ts` (`EvidenceRecord`, `EvidenceKind`). W8 resume, src/contracts validator.

## D-02 invariant (ADR-0002)
Harness NEVER writes flow.json. Only the Task Manager (`src/flow` FlowService) writes flow.json; the harness calls its API via `ManagedFlowPort`. One loop authority = Task Manager. No duplicate coordinator.

## Scenarios (acceptance.feature)
- FI-01 (3): SC_R09_DIRECT_FLOW_FILE_EDIT_DENIED (@release-0 — W7 policy-covered, reuse), **SC_R09_SINGLE_COORDINATOR** (advance managed flow only through Task Manager), **SC_R09_TASK_MANAGER_MIGRATION** (migrate TM task-state before integration — reuse W2 migrateFlow).
- FI-02 (test): one coordinator owns retries/review-fix/completion; flow/harness completion parity + failure-disposition (R1-03).

## Schemas (validate via src/contracts)
- `completion-gate-result`, `evidence-record`/`evidence-ledger`, `harness-run-output`, `session-*`. Task Manager `FlowTask`/`FlowState` (src/flow/types.ts).

## Invariant / integration map
- **ManagedFlowPort** interface (src/harness/flow): `linkRun(taskId, runLink)`, `recordEvidence(taskId, evidenceRefs)`, `completeFromGate(taskId, gate, evidenceRefs, runLink)` — all delegate to the Task Manager `FlowService` API; harness never writes flow.json.
- **gate → disposition mapping:** gate `status:pass`(all checks pass, no undisposed blocker) → `taskDone(disposition:"completed", evidenceRefs, runLink)`; `fail`/undisposed-blocker → `disposition:"failed"`/`"blocked"` (failure-disposition).
- **Additive TM API (chosen):** `FlowService.taskDone` +optional `evidenceRefs?: string[]`, `runLink?: TaskRunLink` (backward-compatible; existing behavior + all prior flow tests unchanged). The Task Manager records them on the task.
- **Single-coordinator parity (FI-02):** harness completion-gate ⟺ Task Manager task completion; no second loop transitions flow state; failure-disposition consistent; TM migration deterministic.

## Target modules
- `src/flow/{types,service}.ts` (FI-01) — ADDITIVE: `taskDone` optional `evidenceRefs?`/`runLink?`.
- `src/harness/flow/managed-flow-port.ts` (FI-01) — `ManagedFlowPort` + adapter over FlowService.
- `src/harness/flow/parity.ts` (FI-02) — pure `completionParity(taskState, gateResult)` + single-coordinator/failure-disposition helpers.

## Decisions (approved)
- src/flow change = **minimal backward-compatible additive** `taskDone(evidenceRefs?/runLink?)`. Harness code under `src/harness/flow/`. Reuse W7/W8/src-contracts; NO rewrite of existing behavior, NO new port/validator/dependency, NO network/SDK; deterministic; harness NEVER writes flow.json.

## Operational
- keryx = `bun ./src/cli.ts`; new worktree needs `bun install`. Never commit to main.
- State only via `keryx flow`; workers via subagent-dispatch/result (STATUS: first line).
- WORKTREE-GUARD: every writing worker `cd ~/goodea/keryx/.claude/worktrees/feature-keryx-harness-impl && pwd` first, write ONLY under it. Verify after each. fetch-mocks `as unknown as typeof fetch`; guard array indexing; immutability via `.toThrow()`. Harness never writes flow.json (only via FlowService API).
- TDD order: FI-01 (T5→T6), FI-02 (T7), review T8.
