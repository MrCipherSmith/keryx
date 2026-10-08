# Flow Journal

- 2026-10-08T09:44:53.533Z - flow created
- 2026-10-08T09:49:45.005Z - task-added: T5: Classify recoverable transport/HTTP/stream/auth failures and define safe 403 policy and recovery defaults
- 2026-10-08T09:49:45.185Z - task-added: T6: Wire recovery lifecycle, countdown and cancellation into readline and OpenTUI without input/wake races
- 2026-10-08T09:49:45.349Z - task-added: T7: Document recovery policy, permanent access errors and partial-effect limitations
- 2026-10-08T09:49:45.561Z - frozen: 10 criteria; checksum recorded
- 2026-10-08T09:49:45.829Z - started
- 2026-10-08T10:20:52.027Z - task-done: T1: Collect remaining context
- 2026-10-08T10:20:52.249Z - task-done: T5: Classify recoverable transport/HTTP/stream/auth failures and define safe 403 policy and recovery defaults
- 2026-10-08T10:20:52.459Z - task-done: T2: Implement per plan
- 2026-10-08T10:20:52.652Z - task-done: T6: Wire recovery lifecycle, countdown and cancellation into readline and OpenTUI without input/wake races
- 2026-10-08T10:20:52.866Z - task-done: T3: Add/adjust tests and make them pass
- 2026-10-08T10:20:53.067Z - task-done: T7: Document recovery policy, permanent access errors and partial-effect limitations

## Implementation handoff — 2026-10-08

Implemented interactive same-round recovery in this worktree; 949 focused tests
pass, final 26-test recovery suite passes, main/scripts typecheck and changed-file
lint pass. See [implementation-evidence.md](implementation-evidence.md) for exact
changed paths, commands, results, AC mapping and limitations.

The broader sweep has one remaining real sandbox-hook failure after fixing two
stale source audits. Independent sandbox-exec reproduction is refused by this
environment (Operation not permitted). Real PTY tests were skipped by their
existing guard; no live provider test or full launched-TUI invalidation race was
run. These are not claimed as passes.

T1/T2/T3/T5/T6/T7 closed through the flow CLI; T4 stays open for the main agent.
Flow remains in-progress. Frozen AC unchanged and unconfirmed. No commit or
publication performed.


## 2026-10-08 — independent-review blocker continuation

Repaired recognized SSE reader transport failures across all four adapters and
session-bound foreground callback/finalizer invalidation while retaining ownership
until settlement. Added native body-error/recovery and session-switch race fixtures.
Readline now separates latest request context usage from summed turn spend usage.
See [continuation-report.md](continuation-report.md) for commands, evidence and
remaining failed completion-wake/time-out checks. Flow/task/AC state was not changed;
T4 remains open, no AC certified, and no commit/push/rebase/merge/release performed.
- 2026-10-08T11:04:26.796Z - task-done: T4: Self-review and prepare draft PR
- 2026-10-08T11:04:27.204Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/926 (tracker unavailable: existence not verified)

## 2026-10-08 — PR #926 CI repair continuation

Read the failed CI artifact with bounded ctx filtering. Local reproduction found
the stale 12→13 TUI source-reader manifest and both readline pruning regex windows
outgrown by recovery options. Inspected the real archive flags and TUI session
invalidation/settlement paths before changing tests. The inventory now documents
the added safety reader; the pruning checks select actual calls with TypeScript
syntax and require archive-enabled literal true, with no later override. Negative
guard cases reject missing, false and misplaced flags. Production source and
pause timeouts are unchanged.

Final affected sweep: 183 pass / 0 fail across inventory, pruning, pause-process
and TUI shell tests. Holder-killed: 50/50 fresh focused runs passed, as did the
terminal matrix case; the CI timeout remains unreproduced, with a documented
pre-existing presence-before-cursor startup-race hypothesis rather than a claimed
fix. Final changed-test lint and main typecheck pass. Terminal gate: 2,230 pass,
3 skip, 9 fail. Smaller failure rechecks retain only the three inherited
agent-origin `/schedule` refusals; other terminal failures pass their rechecks.
The earlier affected scan-hook timeout and failed broad gates are retained as
failed evidence, never replaced by the later focused passes. Full core-gate
results and exact logs are recorded in [pr-validation.md](pr-validation.md).

The requested actual PR base is `main`, but the recorded base remains
`fix/tui-input-latency`: CLI help and source expose `--base` only at init, with no
supported base-repair command. No hand edit to CLI-owned state was made.
`flow.json`, AC confirmations, owner, review evidence and the pre-existing dot
report are unchanged by this repair. The prior implemented label does not prove
a reviewed merge. No flow completion, worktree commit, push, merge, tag, release
or authentication switch was performed. Generated graph outputs were preserved
outside the worktree and restored; unrelated artifacts were preserved.
