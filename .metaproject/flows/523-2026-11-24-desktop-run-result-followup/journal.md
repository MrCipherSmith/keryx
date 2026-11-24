# Flow Journal

- 2026-11-24T20:53:10.991Z - flow created
- 2026-11-24T20:53:28.989Z - origin-set: unknown -> human-request; quote: "Мы должны научить его следить за выполнением так как он же просит выполнить и ему нужен результат"; source: claude desktop session 2026-11-25 (the owner asked for it in the desktop session)
- 2026-11-24T20:59:18.587Z - task-added: T5: Host: pty_open_command and pty_tail with Rust tests and TS wrappers
- 2026-11-24T20:59:19.848Z - task-added: T6: keryx: terminalResults prompt meta, untrusted notes, floor, replay, initialize meta, system-instruction guidance
- 2026-11-24T20:59:25.664Z - task-added: T7: Desktop: run tracking, delivery on idle, run card and replay
- 2026-11-24T20:59:26.905Z - task-added: T8: Spec: run tab, wire meta, waiting rule in the desktop specification
- 2026-11-24T20:59:28.083Z - task-added: T9: Live check in the installed desktop app (owner)
- 2026-11-24T21:05Z - orchestrator: Phase 0 — `keryx flow list` shows 112 interrupted flows; none is about the desktop Run button or terminal results, so a new flow was created instead of asking resume-or-new per flow.
- 2026-11-24T21:05Z - orchestrator: owner decisions (question tool): one tab per Run (not OSC 133 shell integration); the agent continues on its own (follow-up turn), not a note only; run through flow-orchestrator; execution metrics: no.
- 2026-11-24T21:05Z - orchestrator: AC kinds all classified (11 exec, 1 invariant, 1 judged) — no kinds question needed. Matrix choices made by the orchestrator, open to the owner in review: closing the run tab before the end sends nothing; a long-running command is sent only on "Send output now" (no timeout); finished results wait for the session's turn to end and go in one prompt; undelivered runs are not persisted across a window reload.
- 2026-11-24T21:05Z - orchestrator: environment — `cargo` is at /opt/homebrew/opt/rustup/bin (not on the agent shell PATH); the gdgraph graph is not built in this worktree.
- 2026-11-24T21:07:41.241Z - frozen: 13 criteria; checksum recorded
- 2026-11-24T21:07:42.526Z - started
- 2026-11-24T21:07:48.685Z - task-done: T1: Collect remaining context
- 2026-11-24T21:07:49.919Z - task-done: T2: Implement per plan
- 2026-11-24T21:07:51.092Z - task-done: T3: Add/adjust tests and make them pass
- 2026-11-24T21:08:47.649Z - task-attempt: T5: started (attempt 1) — 523-T5
- 2026-11-24T21:08:48.787Z - task-attempt: T6: started (attempt 1) — 523-T6
- 2026-11-24T21:35Z - orchestrator: edit guard not checked — `.metaproject/tasks.config.json` does not exist in this project, so `review.jev.edit_guard` is off.
- 2026-11-24T21:35Z - orchestrator: T5 returned DONE_WITH_CONCERNS (results/T5.json); validated against resolved/T5.implement.json (every must_read cited). AC2 command 9 passed / 0 failed; pty/panels/panel_mcp 22 passed; cargo check, clippy -D warnings, tsc pass. Concerns, all pre-existing, none fixed in T5:
  1. Output of a fast-exiting process can be missing from the ring after exit (the existing test `a_program_runs_directly_with_its_title_and_reports_its_exit_code` failed 1 of 5 full-suite runs; suspected cause: unread PTY output lost when the child closes the last slave fd before the reader drains it). `pty_tail` after exit depends on it → AC3 could deliver empty/short output under load. Carried to the first-green gate as a hardening option; T7 is told about it.
  2. portable-pty 0.9.0 reports a signal-killed process as code 1, never null, so `exitCode: null` ("ended by a signal") is not produced for Run tabs. The wire still allows null; T7 must not rely on it; the closed-tab case is detected client-side.
  3. Environmental here: shellenv ×3 and `appupdate::run_status_reads_a_fake_keryx` fail in most full-suite runs also with T5's tests skipped.
  Gitignored build prerequisites left in place: `apps/desktop/src-tauri/binaries/keryx-aarch64-apple-darwin` stub and an empty `apps/desktop/dist/`.
- 2026-11-24T21:32:28.009Z - task-done: T5: Host: pty_open_command and pty_tail with Rust tests and TS wrappers
- 2026-11-24T21:40Z - orchestrator: T6 returned DONE_WITH_CONCERNS (results/T6.json); validated against resolved/T6.implement.json (every must_read cited). Re-ran `bun test src/acp/terminal-result`: 59 pass / 0 fail. Worker also reports `bun test src/acp/` 516 pass (base 457), `bun run typecheck` and eslint on the changed files clean. The floor is the existing `untrustedPrompt` option of runAgentTurn (sets `untrustedContentSeen`, src/commands/agent.ts:3479).
- 2026-11-24T21:40Z - orchestrator: T6 behavior_changes (needs_operator), asked one question each; the owner kept every implemented choice: (1) output cap 16 KiB per result (not 8 KiB, not a per-prompt cap); (2) strict validation — an unknown entry field or a repeated runId is invalid params, so T7 sends exactly the six fields and each run once; (3) replay fallback for clients that do not read the meta: `$ <command>` then the stored output; (4) model-facing wording kept as written, to be checked in review and the live run (AC13).
- 2026-11-24T21:40Z - orchestrator: T6 concern kept for the first-green gate — the reused floor keeps its existing carve-outs: in trust mode `isTrustRoutineCommand` commands (e.g. `bun test`, read-only git) still run unasked in a terminal-results turn, and read tools / floor-exempt first-party MCP tools never ask (src/commands/agent.ts:6051-6059). AC6 holds for non-routine calls (tests use `touch`). Changing the floor itself was out of the dispatch's scope. Skill drift reported: src/acp has no project skill.
