# Flow Journal

- 2026-11-02T07:11:42.059Z - flow created
- 2026-11-02T07:29:45.080Z - origin-set: unknown -> human-request; quote: "да, запускай flow под пункт 1,2,3"; source: claude-code session 471f0119, 2026-11-02 (operator asked for items 1-3 after the herdr.dev analysis)
- 2026-11-02T07:30:08.911Z - task-added: T5: OSC 7501 encoder, herdr-core state mapper and reporter (pure module + tests)
- 2026-11-02T07:30:28.787Z - task-added: T6: Wire herdr-core reporter into the TUI: ready idle, matrix states, blocked kind+text, clear on exit, render-safe writer, debug env
- 2026-11-02T07:30:33.936Z - task-added: T7: keryx shell positional initial prompt submitted as the first turn
- 2026-11-02T07:30:38.944Z - task-added: T8: hc agent-message framing and herdr-core section in the shell agent context
- 2026-11-02T07:30:48.322Z - task-added: T9: keryx herdr install/remove/status: programs.json entry, icon, herdr-core template, registry
- 2026-11-02T07:30:53.844Z - task-added: T10: Docs: herdr guide, CLI reference, upstream programs.json snippet
- 2026-11-02T07:30:58.131Z - task-added: T11: Live verification under isolated herdr-core session: status sequence, template first_message.sent, positional prompt, screen integrity (AC13, AC14)
- 2026-11-02T07:31:03.966Z - task-added: T12: Live check in the operator's Herdr app: keryx in the + menu, no programs.error (AC15, operator go-ahead)
- 2026-11-02T07:31:22.208Z - task-done: T1: Collect remaining context
- 2026-11-02T07:31:29.555Z - task-done: T2: Implement per plan
- 2026-11-02T07:31:36.829Z - task-done: T3: Add/adjust tests and make them pass
- 2026-11-02T07:31:50.227Z - task-depends-set: T4: dependsOn T10, T11 (was empty) — review runs on the finished implementation and docs

## Decisions (flow-orchestrator, 2026-11-02)

- New flow, not a resume: the in-flight flows (incl. 479 on `feat/flow-479-question-body`) do not
  match this request; flow 124 (old herdr socket integration) is done. Standing default: start a
  new one and say so.
- Worktree `/Users/tsaitler.aleksandr/goodea/keryx/.claude/worktrees/herdr-app`, branch
  `feat/flow-481-herdr-app` from `origin/main` — keeps flow 479's checkout untouched.
- Execution metrics: no (standing operator default, not asked).
- Parent role in Part 3 = instructions + `hc` through `shell_exec`, no new harness tool:
  interactive `shell_exec` is unsandboxed by default (`KERYX_SANDBOX_SHELL` opt-in) and already
  approval-gated. The herdr-core socket is never opened inside the OS sandbox: the core runs
  anything unsandboxed, so that would be a full escape. Derived from the code and wiki, not asked.
- Readline fallback keeps no herdr-core status (it never had the old reporter); out of scope.
- `herdrStateFor` untouched: the agent bus schema has no `done`/`error`.
- Upstream PR to herdr-app is prepared as docs only; sending it is an operator decision.
- AC kinds were unambiguous (exec for tests, judged for the three live runs) → no kinds question.
- 2026-11-02T07:32:41.100Z - frozen: 17 criteria; checksum recorded
- 2026-11-02T07:32:49.592Z - started
