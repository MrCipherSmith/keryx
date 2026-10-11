# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx review run --autonomous --target pr --ref <url> [--budget-minutes N] [--budget-tokens N] [--out <dir>]` starts the review in the named profile `review-autonomous` over `keryx shell --print`; the profile is defined in one place and sets mode `trust`, `review-auto`, source-only execution, the round limit and the wave size.
- AC2: It needs no TTY: a test starts it with stdin closed and stdout a file, and it finishes; it never opens a prompt.
- AC3: Exit codes are fixed and documented: 0 complete (accepted `review complete`), 2 incomplete (coverage not reached), 3 stopped by a floor, 4 budget exceeded, 5 stalled; a test per code with a stubbed model.
- AC4: A question that policy cannot answer (a floor, an `ask_user` menu) does not wait: it is answered by the safe default (refusal, or the recommended option only where the profile marks it safe), recorded in the journal, and the run goes on or ends with exit 3; a test shows no wait.
- AC5: Budgets are enforced: wall clock and tokens; when exceeded the run stops at a safe point, keeps the package, and writes status `incomplete` with the reason; a test with a tiny budget.
- AC6: A stall watchdog ends the run with exit 5 and the last phase named when no tool call or model event happens for the stated minutes (default 10); a test with a model stub that hangs.
- AC7: The run writes `summary.json` (status, exit code, findings by severity, rounds, coverage, cost, list of automatic answers and refusals) and `report.md` next to the package; the schema is validated by a test.
- AC8: A second start on the same PR head reuses or resumes the existing package; two starts at once are refused by a lock with a named error; a test for each.
- AC9: The run is registered in the existing keryx scheduler as a job kind, and `docs` give a cron and a systemd-timer example; a test creates and lists the scheduled job.
- AC10: The TUI shows a running autonomous review (phase, rounds, cost, the last automatic answer) in the sidebar, and a menu/command starts, lists and stops runs; the Telegram relay sends one line at start and one at the end.
- AC11: Live: the review of Presight-AI/vantage-frontend PR 7435 started by the autonomous entry from a plain shell with no TTY and no input reaches an accepted `review complete` with about 5 Majors in about 2 rounds; time, tokens and findings are recorded beside the Claude run (17m58s, 2x10 reviewers, 5 Majors). This is also the evidence for flow 417 AC16 and flow 418 AC12.
- AC12: The docs (a guide for scheduled reviews, the CLI reference) and the CHANGELOG describe the profile, exit codes and budgets; the docs site builds with --strict.
