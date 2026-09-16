# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: With a task registry, `shell_exec({command:"sleep 120 && gh run list --workflow=release.yml"})` with no `background` flag returns within `yieldMs` (test drives a never-exiting fake and a short injected yield) carrying a `task_id` matching `^task-[0-9]+-[0-9]+$`; the task is then readable via `shell_job_output(task_id)` and stoppable via `shell_job_kill(task_id)`, ending `killed` with `killReason: "model"`.
- AC2: A command that exits within `yieldMs` returns the synchronous-shaped result with no task handle: trimmed combined output, `(no output; exit N)` when empty, `isError` true exactly for a non-zero exit, and output capped at 20 000 bytes followed by `…(truncated)`.
- AC3: Idle timeout replaces the wall-clock deadline: a real command that prints at intervals shorter than the idle timeout survives well past several idle periods, while a silent real command is killed after the idle timeout with `killReason: "idle"` and a message naming `KERYX_SHELL_IDLE_MS`; `idle_timeout_ms` is clamped to [1000, 1800000]; `KERYX_SHELL_IDLE_MS` defaults to 120000 and falls back to `KERYX_SHELL_TIMEOUT_MS` when unset; `KERYX_SHELL_YIELD_MS` defaults to 10000; malformed values fall back to the defaults.
- AC4: Terminal status is `completed` for exit 0, `failed` for a non-zero exit, and `killed` with `killReason` one of `model`, `operator`, `idle`, `output-cap`, `session-exit` (sweep reports `session-exit`, the output-cap rail reports `output-cap`); exactly one `exit` event per task, carrying the same status and `killReason`.
- AC5: The concurrency cap counts only background-phase tasks: with `maxConcurrent` background tasks running, a foreground `shell_exec` still starts and returns its result; `background:true` over the cap is refused with an error naming the running commands; a foreground task that outlives its yield while the cap is full is not killed and its handle reports the cap; running tasks never exceed `maxConcurrent + 1`.
- AC6: Killing a task started through `shell_exec` (real process, `sh -c 'sleep 300 & …'` shape) terminates the grandchild the command backgrounded (process-group kill), asserted by the grandchild no longer being alive.
- AC7: Without a task registry `shell_exec` uses the injected synchronous runner exactly as before, and a test pins that both production `buildInteractiveAgentTools` call sites in `src/commands/shell.ts` pass a registry.
- AC8: `BackgroundJobStore` lists a task only after its `phase: "background"` event (output received before it is retained), never lists a task that exits while still foreground, and renders `completed`, `failed` and `killed` statuses.
- AC9: Approval, sandbox and session sweep stay unchanged: `bun run typecheck` passes and `shell-exec-tool.test.ts`, `shell-exec-timeout.test.ts`, `shell-exec-background.test.ts`, `background-job-registry.test.ts`, `interactive-agent-tools.test.ts`, `agent-permission-mode.test.ts`, `agent.test.ts`, `shell.test.ts` and `tui-shell.test.ts` pass (updated only where they asserted the replaced ids, statuses, start buffer or wall-clock deadline).
