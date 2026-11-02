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
- 2026-11-02T09:12:13.588Z - task-done: T10: Docs: herdr guide, CLI reference, upstream programs.json snippet
- 2026-11-02T09:12:27.976Z - ac-confirmed: AC16: bun run docs:check: 2012 relative links / 672 files, 0 broken; retired spellings 0 undeclared; cli-reference-coverage + commands-by-task + help-groups 67 pass. Guide docs/docs/guides/herdr.md (commit 51de6ad24) covers status protocol, keryx herdr install/remove/status, template, delegation via hc, sandbox caveat, old Herdr TUI coexistence, upstream programs.json entry + icon; cli-reference lists keryx herdr and the positional shell prompt. (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-11-02T11:46:57.167Z - ac-updated: T4 review round 1: AC9's 'hc cannot reach the core from the sandbox' is false in workspace mode (network on keeps the herdr-core socket reachable; degradation F-001), so the section now says the sandbox does not contain hc. AC8 gains the review's hardening: from/reach shape checks, fail-closed framing of unparsed hc-shaped lines, operator-only routes skipped, Telegram lines never framed.
- 2026-11-02T11:47:35.248Z - ac-confirmed: AC13: Re-confirmed after the AC8/AC9 re-freeze; evidence unchanged. Live, isolated hc session keryx481 (hc 0.1.16, dev keryx f3a30d440): idle after start (k4), working->done on hc send --wait (k1), blocked kind=permission msg=<cmd> on a shell approval (k1), status null 20 ms before exit (k4), no 7501 text in any hc read screen. Later review fixes move the exit clear earlier in teardown and retry a failed write; neither changes the observed sequence. Evidence: flows/481-*/live/README.md, events.jsonl (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-11-02T11:47:37.928Z - ac-confirmed: AC14: Re-confirmed after the AC8/AC9 re-freeze; evidence unchanged. Live, isolated hc session: template run 'hc run --bg --name k2 keryx <task>' returned first_message.sent=true, task became turn 1 (READY, done); positional 'hc run --bg --name k3 <keryx path> shell <task>' idle->working->done with the prompt as the first turn. Evidence: flows/481-*/live/README.md, k2/k3 screens, events.jsonl (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- 2026-11-02T11:47:40.610Z - ac-confirmed: AC16: Re-run after the review fixes rewrote the guide's sandbox and agent-message sections: bun run docs:check: 2013 relative links / 672 files, 0 broken; retired spellings 0 undeclared; cli-reference-coverage + commands-by-task + help-groups 67 pass. Guide docs/docs/guides/herdr.md covers status protocol, keryx herdr install/remove/status, template and its shadowing, delegation via hc, agent-message framing and its shape checks, the per-mode sandbox caveat, old Herdr TUI coexistence, upstream programs.json entry + icon; cli-reference lists keryx herdr and the positional shell prompt. (signed: 200531777+MrCipherSmith@users.noreply.github.com [derived])
- T8, T10, T11 results (recorded together with the T4 review round 1 fixes):
  - T8: hc framing and the herdr-core section shipped in 51de6ad; live check in T11 covered the
    report form only (`hc send` injected one `<hc from>` line), the `reach` task form is unit-tested.
  - T11 found that the `keryx` template shadows the program: once installed, `hc run keryx shell`
    runs the template with the task `shell`. The guide warns about it, and the agent's hc section
    now names the template form (`hc run --bg --name <name> keryx "<task>"`) instead of
    `keryx shell "<task>"`.
  - T10: guide and CLI reference; AC16 re-confirmed after the review rewrote two guide sections.
- T4 review round 1 (package 2026-11-02-review-flow-github-com-mrciphersmith-keryx-pull-1116, 73
  findings, 7 major). Fixed in the working tree, one commit to follow:
  1. Sandbox claim corrected (degradation-w2 F-001, verified): `workspace` mode (also `1`/`on`)
     builds a network-on Seatbelt profile under `(allow default)`, so the herdr-core socket stays
     reachable and whatever hc starts runs outside the sandbox; only macOS `strict` denies it, and
     bubblewrap's `--unshare-net` never isolated path unix sockets. Guide, the agent's hc section,
     AC9 and the PR body now say the sandbox does not contain hc. Containing the socket is a
     follow-up, not this flow.
  2. Readline: a positional prompt skips the agent/chat question (picking chat used to drop it).
  3. hc messages: `from`/`reach` shape checks; fail-closed framing of a line that starts like
     `<hc` but does not parse; an empty body is named; agent-shaped lines skip the wiki-enrich
     picker and the busy dialog (main queue instead); Telegram lines are never framed and keep
     `tg ❯`; the scroll pin and the resume summary show the sender like the live echo.
  4. TUI startup: with a positional prompt (and on the read-only view, same loss on main) the
     R700-01 hook notices go to the transcript, not into a splash removed before its first frame.
  5. herdr-core status: redaction over a bounded 4096-char window before the 200-char cut; a
     failed write is not remembered; the status is cleared first in the shell's finally.
  6. `keryx herdr`: an invalid programs.json stops the run before the icon and template; the
     backup never writes through a symlink; a symlinked programs.json stays a link; each
     subcommand takes only its listed flags.
  7. Source-text audit inventory gains the three new readers (CI typecheck/AC8 root cause); the
     live scripts lost their personal paths.
- AC8 and AC9 re-frozen with the corrected wording (journaled above); AC13, AC14, AC16 re-confirmed.
- T4 round 1, post-fix (fix commit f4995a7fb):
  - Wave C: the post-fix verifier refuted all 24 acted-on findings at f4995a7fb by execution,
    each citing its saved `keryx review verify-run` output. It named three residuals, closed in the
    follow-up commit: an unparsed `<hc`-shaped line is echoed as `◂ unknown agent ❯` (SECO3-F-001);
    the main-agent status uses FleetWorkerStatus and the herdr-core mapper is exhaustive
    (ARCH3-F-001); the sandbox source scan rejects any `HC_*` name (TEPR1-F-004).
  - Wave D: the premise judge (claude-opus-5-5, reading the reviewed head 51de6ad) upheld 25 of 26
    and challenged TEPR1-F-002 on the source-text audit inventory. Operator MrCipherSmith answered:
    TEPR1-F-002 dismiss (keep the recorded audit for P2), DEGR1-F-001 dismissed out of scope (the
    package slice was cut from the working tree, a review-tooling issue, not PR code).
  - CI on f4995a7fb was red on one test in both jobs: the import-policy ratchet counted 151 avoidable
    facade bypasses (ceiling 150). Cause: herdr-core-status.ts imported security/redact.ts directly;
    it now imports through security/service.ts (back to 150).
  - Mutation pass 1 overstated kills: `(delete line)` replacements were inserted literally, so those
    mutants died of a SyntaxError. Pass 2 applies them as deletions, re-anchors the four invalidated
    ones, and adds CLI tests for herdr `--dry-run`/`--force` (M-09, M-10 survived). M6 was
    equivalent: the herdr-core section peaks at 1,158 chars, so its runtime 1,500 cut was removed
    (the test keeps the ceiling). M-21 is presentation-only (the rewind label).
  - Review-tooling follow-ups found on the way: a PR round's slices come from the working tree, and
    `keryx review verdict` before ingest reports "no findings" because `review start` writes
    findings.json as `[]`.
- 2026-11-02T13:55:53.042Z - decision d-mvzbnjm1-30797f [review decide-premise, ordinary]: chose dismiss; no recommendation
