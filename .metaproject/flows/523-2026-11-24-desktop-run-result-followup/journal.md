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
