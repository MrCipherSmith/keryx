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
- 2026-11-02T07:34:40.281Z - task-attempt: T5: started (attempt 1) — 481-T5
- 2026-11-02T07:34:44.168Z - task-attempt: T9: started (attempt 1) — 481-T9
- 2026-11-02T07:41:50.574Z - task-done: T5: OSC 7501 encoder, herdr-core state mapper and reporter (pure module + tests)
- 2026-11-02T07:42:24.283Z - task-attempt: T6: started (attempt 1) — 481-T6
- 2026-11-02T07:44:45.709Z - task-done: T9: keryx herdr install/remove/status: programs.json entry, icon, herdr-core template, registry

## Worker results

- T5 (DONE, commit 8828aa275): 75 pass across herdr-core-status/herdr-report/tui-bus (re-run by the
  orchestrator). Redactor = `redactSensitiveText` (src/security/redact.ts), applied before the
  200-code-point cut. `writeOut` typed structurally as `writeOut(chunk: string): unknown`.
- T9 (DONE, commit a0be042b8): 112 pass across herdr + registry/help/cli-reference/commands-by-task
  (re-run by the orchestrator). Choices journaled, none needing the operator: new registry module
  `herdr`; extra JSON action `error` (invalid programs.json, fs failure → exit 1); with an invalid
  programs.json the icon and template targets still proceed; backup `programs.json.keryx-backup` written
  once, before the first install OR remove modification; `--force` is accepted but has no effect on
  `remove`/`status` (candidate review nit); icon embedded as `HERDR_ICON_SVG` (npm package does not ship
  `vscode-extension/`), a test keeps it identical to the source SVG; win32 → every target skipped.
  TDD deviation reported by the worker: code and tests written together, no separate red run.
- 2026-11-02T07:55:46.842Z - task-done: T6: Wire herdr-core reporter into the TUI: ready idle, matrix states, blocked kind+text, clear on exit, render-safe writer, debug env
- 2026-11-02T07:56:07.393Z - task-attempt: T7: started (attempt 1) — 481-T7
- 2026-11-02T08:21:03.174Z - task-done: T7: keryx shell positional initial prompt submitted as the first turn
- 2026-11-02T08:23:04.942Z - task-attempt: T8: started (attempt 1) — 481-T8

## Worker results (continued)

- T6 (DONE, commit e0066834b): 138 pass across herdr-core-status/wiring/herdr-report/tui-bus and the
  three suites that pin tui-shell.ts lines (re-run by the orchestrator). Composite
  `src/tui/agent-host-status.ts`; `markReady()` after the resume picker and held-session choice;
  `exit()` after the single `herdr.release()` in the shell's `finally`; ten blocked sites carry
  kind + text. Noted, not changed: `confirmOperatorCard`/`confirmUserPromptCard` return early when
  the Telegram topic wins and rely on `mirrorApprovalToTopic` to leave `blocked`.
- T7 (DONE, commit c7da91c02): worker's parser, TUI submit and help text accepted; the orchestrator
  fixed two defects before the commit (299 pass across ten shell suites, typecheck clean):
  1. Readline: `withInitialLine` re-delivered the prompt to every new iterator, and the
     provider/mode pickers (`select.ts:230`) build their own iterator over `io.lines`, so the task
     would have been read as a menu answer. Now the prompt goes to `runAgentRepl` alone
     (`replLines`), once in total.
  2. TUI: the shell's `catch` returns `false` for a failure at any point, so a TUI that failed after
     submitting would have fallen back to readline and run the task a second time. The TUI now takes
     the prompt once (`takeInitialPrompt`); the fallback gets only what was never taken.
  `--chat` + prompt is refused (no first-message hook on the chat surfaces). `-r <word>` still reads
  the word as a session id. `shell-cli-validation.test.ts` `["unexpected"]` → `["--unexpected"]`.
- Pre-push gate fix (commit f4427d39c): flow 303 AC5 pins the flat `--help`; T9 had not named its
  herdr lines as allowed additions. The test fake token became `ghp_${"A".repeat(36)}`
  (commit a1813caed), matching the other suites.
- History rewrite before the first push: the first seven commits carried a Co-Authored-By trailer,
  which this repository's rule forbids. Rewritten with `commit-tree` (same trees, authors, dates);
  the old head 3598073da stays in the reflog.
- 2026-11-02T08:44:48.343Z - task-done: T8: hc agent-message framing and herdr-core section in the shell agent context
- 2026-11-02T09:05:51.165Z - ac-confirmed: AC13: Live, isolated hc session keryx481 (hc 0.1.16, dev keryx f3a30d440): idle after start (k4), working->done on hc send --wait (k1), blocked kind=permission msg=<cmd> on a shell approval (k1), status null 20 ms before exit (k4), no 7501 text in any hc read screen. Evidence: flows/481-*/live/README.md, events.jsonl (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-11-02T09:05:53.217Z - ac-confirmed: AC14: Live, isolated hc session: template run 'hc run --bg --name k2 keryx <task>' returned first_message.sent=true, task became turn 1 (READY, done); positional 'hc run --bg --name k3 <keryx> shell <task>' idle->working->done with the prompt as the first turn. Evidence: flows/481-*/live/README.md, k2/k3 screens, events.jsonl (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-11-02T09:05:55.603Z - task-done: T11: Live verification under isolated herdr-core session: status sequence, template first_message.sent, positional prompt, screen integrity (AC13, AC14)
