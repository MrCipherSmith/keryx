# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `shell_task_output` takes `{ task_id, since?: number }` and returns the output after the EXPLICIT cursor plus the task's status, never the whole transcript again; two successive calls with the same `since` return the same bytes, and omitting `since` does not advance any shared cursor.
- AC2: `shell_task_wait` takes `{ task_ids: string[], mode: "any" | "all", timeout_ms?: number }` and returns a per-task status and output; `mode: "any"` returns as soon as one task is terminal, `mode: "all"` only when every named task is; an unknown `task_id` is a tool error naming it, not a silent omission.
- AC3: `shell_task_wait.timeout_ms` is clamped to [0, 300 000] whatever the model passes, and reaching the bound returns the still-running tasks with their status rather than an error; a wait NEVER kills a task, asserted for both the timeout and the abort path.
- AC4: `shell_task_kill` process-group kills the task and is idempotent for one that has already exited: the second call returns an ordinary tool error and never re-signals, and the task's terminal event count stays at one.
- AC5: `shell_job_output` and `shell_job_kill` keep working as aliases for one release and accept BOTH `job-*` and `task-*` ids — a test pins all four combinations — and each alias carries a deprecation note naming its replacement in the tool DESCRIPTION the model is actually sent, asserted over the built tool definition rather than over the source text.
- AC6: `InteractiveTool.invoke` accepts `(input, ctx?: { signal?: AbortSignal })` and `executeCall` passes the turn's signal; every existing tool that ignores `ctx` is unaffected, proven by the existing suites passing unchanged.
- AC7: On abort, `shell_task_wait` and `shell_exec`'s yield wait return PROMPTLY with `interrupted: true` and the tasks still `running` — not killed — and those tasks' completions are still delivered afterwards through the P1 drain, exactly once.
- AC8: The operator demotes a running foreground task with `/demote <task_id>`, available in BOTH shells (TUI and the readline REPL), and the turn is not aborted: the demote releases the caller's wait through the same path an abort uses, the task keeps running with its output intact, and it enters the TUI task list from its `phase` event (which fires at most once per task). The command is proven by EXECUTING its handler against a registry — an unknown id and an already-background task each return a stated error rather than throwing — not by a source audit.
- AC9: Side workers are denied `shell_task_kill`, `shell_job_kill`, `shell_task_wait` and `shell_job_output`; only `shell_task_output` is offered to them, and the denial is asserted over the roster a side worker is actually built with, not over a name list.
- AC10: A side worker's `shell_task_output` NEVER marks a task observed: after a side worker reads a task that has already finished, the main session still receives exactly one notification for that task; only tools built for the main session mark observation.
- AC11: `shell_task_output`, `shell_task_wait` and `shell_job_output` are repeatable tools, so a legitimate poll does not trip the repeated-call guard, while the per-signature attempt rail still stops a genuine loop.
- AC12: P0 and P1 are unchanged: approval, sandbox resolution, process-group kill, the session sweep and exactly-once delivery keep their existing proofs, and `bun run typecheck` plus `shell-exec-tool.test.ts`, `shell-exec-timeout.test.ts`, `shell-exec-background.test.ts`, `background-job-registry.test.ts`, `agent-task-notification.test.ts`, `interactive-agent-tools.test.ts`, `agent-permission-mode.test.ts`, `agent.test.ts`, `shell.test.ts` and `tui-shell.test.ts` all pass.
