# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `shell_exec({command, background:true})` returns without waiting for the process to exit and its result carries a `job_id`; `DEFAULT_SHELL_TIMEOUT_MS` does not fire on it even when the command outlives 120s — verified by a test that starts a long-sleeping background command and asserts the tool call resolves quickly with no timeout error.
- AC2: `shell_job_output(job_id)` returns only output produced since the previous call for that `job_id` (incremental, cursor-based), never a full re-dump of everything so far — verified by a test asserting two successive calls after two output bursts each return only their own burst.
- AC3: `shell_job_kill(job_id)` terminates the job's entire process group, including a grandchild the direct child spawned and exited before (e.g. `sh -c 'sleep 1 & sleep 100'`-shaped case) — verified by a test asserting the grandchild is actually gone after kill, not just the direct child.
- AC4: `shell_job_kill`/`shell_job_output` only accept a `job_id` present in the calling session's own `JobRegistry`; an unknown or foreign id returns a tool error and never affects any OS process — verified by a test.
- AC5: Starting a background job beyond `MAX_CONCURRENT_BACKGROUND_JOBS` (default 3, override via env) returns a tool error naming the currently running jobs; it never silently queues or evicts an existing job — verified by a test.
- AC6: `shell_job_output` and `shell_job_kill` are both classified `risk: "read"` in the tool budget split (`src/commands/agent.ts`) and do not consume the small non-read tool-call pool — verified by a test extending the existing budget-split test coverage.
- AC7: On graceful interactive session exit (`keryx shell` / TUI exit path), every job still tracked in `JobRegistry` is SIGTERM→SIGKILL'd by process group; no process started through the registry survives the session — verified by a test.
- AC8: The TUI sidebar shows a "Background Jobs N" panel; each row's mouse-down opens a modal (via the shared `openModal`) showing that job's Output/Meta tabs, mirroring `subagent-inspector.test.ts`'s "rows fire onOpen on mouse down" pattern — verified by a TUI test.
- AC9: `BackgroundJobStore` entries persist across a new agent turn and across `/clear`/`/new` (unlike `SubagentSessionStore`, which resets on both) — cleared only by an explicit kill or session teardown — verified by a test asserting a running job's entry survives a simulated new-turn/`/clear` event.
- AC10: Starting a background job (`background: true`) is gated by the exact same `resolveApprovalDecision` outcome as an ordinary `shell_exec` call across all three permission modes (`ask`/`trust`/`auto`), with the same destructive/credentials floor — no separate or stricter gate — verified by a test extending `agent-permission-mode.test.ts`.
