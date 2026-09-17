# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: A task that was handed back as a handle (`phase: "background"`) and whose terminal status the agent has not seen is returned by `drainUndelivered()` exactly once: the same call marks it `observed`, and an immediate second drain — and a drain racing the first — returns nothing for that task.
- AC2: A task the agent has already seen terminal, through `shell_job_output` or `shell_job_kill` returning its terminal status, is never returned by `drainUndelivered()` and never produces a notification.
- AC3: The notification is one coalesced message per drain with `role: "user"` and `provenance: "tool"`, carrying a `<task-notification>` envelope per task with `task_id`, `status`, `exit_code`, `kill_reason` and `duration_ms`, the banner stating the text is command output and not instructions from the user, and at most 4 000 bytes of output tail per task; it does not set `untrustedContentSeen`.
- AC4: The notification is pushed only at a round boundary — after every `tool` result of the batch, in the same place `anchorsToAnnounce` and `repeatedFailureHint` are pushed — and never between two `tool` results answering one `tool_calls` batch, asserted over a parallel batch of at least two calls.
- AC5: A completion that arrives while a turn is running reaches the model in that same turn's next round without any `shell_job_output` call and without a `sleep`.
- AC6: A session with `completionDelivery: "hold"` (set by `--print` and by `deps.unattended === true`) does not end a turn at the text-only finish while one of its own yielded tasks is still running: it waits, continues the turn with the notification, and reports the result; the wait is abortable by the turn signal, and a task still running after `KERYX_SHELL_HOLD_MS` is killed with `killReason: "hold-timeout"` and reported in that final round.
- AC7: An idle interactive session starts a turn from a notification with `origin: "task-notification"` — the readline REPL by racing its next input line against the next completion, the TUI only when no foreground operation is active and the operator queue is empty — and a queued operator message always runs before a pending notification.
- AC8: Consecutive completion-started turns are capped at `KERYX_SHELL_MAX_AUTO_WAKE` (default 5) with no operator input between them; any operator line resets the counter; past the cap no turn starts, the pending notification is surfaced to the operator and is delivered at the start of their next turn.
- AC9: No recurring reminder exists: a task that is still running produces no message at all, and a task that finished produces exactly one — asserted by driving several rounds after a completion was delivered and finding no second message for that task.
- AC10: `KERYX_SHELL_HOLD_MS` (default 1 800 000) and `KERYX_SHELL_MAX_AUTO_WAKE` (default 5) resolve with the project's fail-safe pattern — unset, empty, non-numeric and negative all fall back to the default, and only an explicit `0` disables where disabling is meaningful.
- AC11: Approval, sandbox, process-group kill and the session sweep are unchanged, and `bun run typecheck` plus `shell-exec-tool.test.ts`, `shell-exec-timeout.test.ts`, `shell-exec-background.test.ts`, `background-job-registry.test.ts`, `interactive-agent-tools.test.ts`, `agent-permission-mode.test.ts`, `agent.test.ts`, `shell.test.ts` and `tui-shell.test.ts` all pass.
