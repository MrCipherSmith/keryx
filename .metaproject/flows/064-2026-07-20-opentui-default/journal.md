# Flow Journal

- 2026-07-20T08:51:48.553Z - flow created
- 2026-07-20T08:51:48.725Z - task-added: T5: implement default + stdin handoff
- 2026-07-20T08:51:48.816Z - task-added: T6: smoke + verify
- 2026-07-20T08:51:48.903Z - frozen: 4 criteria; checksum recorded
- 2026-07-20T08:51:48.984Z - started
- 2026-07-20T08:51:49.063Z - task-done: T1: Collect remaining context

## Phase 2/3 — implement + verify (orchestrator)
- shell.ts: agent mode on an interactive TTY now launches launchTuiAgentShell BY DEFAULT (condition: !--no-tui && process.stdout.isTTY); `--no-tui` forces readline; `--tui` kept as an accepted no-op alias. stdin handoff via onStart:()=>rl.close() (called only after the renderer inits). readline REPL retained as the guaranteed fallback (NOT retired).
- tui-shell.ts: launchTuiAgentShell(deps, { onStart? }) invokes onStart right after createCliRenderer succeeds.
- Verify: tsc CLEAN; `bun test` **1506 pass / 3 skip / 0 fail** (baseline 1506). Smokes: non-TTY `--agent` (default, no --tui) → readline; `--no-tui` → readline. runAgentTurn/chat/roleLabel unchanged; no new dependency. Reversible (one condition/flag). Retiring readline deferred until a live sign-off.
- AC1-AC4 satisfied.
- 2026-07-20T08:53:32.457Z - task-done: T2: Implement per plan
- 2026-07-20T08:53:32.549Z - task-done: T3: Add/adjust tests and make them pass
- 2026-07-20T08:53:32.625Z - task-done: T5: implement default + stdin handoff
- 2026-07-20T08:53:32.698Z - task-done: T6: smoke + verify
- 2026-07-20T08:53:41.101Z - implemented: draft PR: https://github.com/MrCipherSmith/keryx/pull/100
- 2026-07-20T08:53:41.211Z - ac-confirmed: AC1: agent TTY launches TUI by default; --no-tui forces readline; --tui no-op alias
- 2026-07-20T08:53:41.377Z - ac-confirmed: AC2: readline retained as fallback; non-TTY --agent → readline (smoke); chat unaffected
- 2026-07-20T08:53:41.473Z - ac-confirmed: AC3: onStart closes rl only post-init; pre-init fallbacks keep readline usable
- 2026-07-20T08:53:41.580Z - ac-confirmed: AC4: tsc clean; bun test 1506/0; non-TTY + --no-tui smokes → readline; no new dep; driver/chat/roleLabel unchanged
- 2026-07-20T08:54:05.319Z - completing
- 2026-07-20T08:54:05.359Z - done: all gates passed
