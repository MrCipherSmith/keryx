# Background shell jobs: run_in_background shell_exec + sidebar job inspector

Status: formalized
Source: user description + design discussion (this flow's `journal.md` / prior conversation)

## Problem

`shell_exec` (`src/harness/tool/builtin/shell-exec-tool.ts`) is the interactive
agent's only execute capability, and it is strictly synchronous: the agent
turn blocks on `await proc.exited`, with a hard `DEFAULT_SHELL_TIMEOUT_MS`
(120s) deadline that SIGTERMs then SIGKILLs anything still running. There is
no way to start a long-running process (a dev server, `tail -f` a log, a
watch build) and keep working while it runs — the exact "2 active shells"
capability the user has seen in Claude Code (`run_in_background` +
`BashOutput`/`KillShell`).

The user wants this in keryx, presented not as Claude Code's below-input text
list but as a **sidebar panel with clickable rows that open a modal showing
that job's live output** — reusing the existing Subagent Inspector pattern
(`src/tui/subagent-session.ts` + `subagent-inspector.ts` +
`subagent-bridge.ts`, flow 162) rather than inventing a new UI primitive.

## Expected Outcome

**Harness / model-facing layer:**
- `shell_exec` gains an optional `background?: boolean` input. When true it
  returns immediately (`{ job_id, pid }` + first ~500ms of output) instead of
  blocking until exit; the existing 120s deadline does not apply to it.
- Two new tools, both `risk: "read"` (no approval — see rationale below):
  `shell_job_output(job_id)` (incremental, cursor-based new-output-only, like
  `BashOutput`) and `shell_job_kill(job_id)` (process-group kill, restricted
  to jobs in this session's own registry — it cannot target an arbitrary
  PID).
- A session-scoped `JobRegistry`: hard cap `MAX_CONCURRENT_BACKGROUND_JOBS`
  (default 3, `KERYX_MAX_BACKGROUND_JOBS` override) — exceeding it is a
  visible tool error listing current jobs, never a silent queue. Kill is by
  **process group**, not bare PID (closes the exact bug class hit live by
  opencode's FD-inheritance hangs and Codex's sandboxed-`pgrep` blindness —
  see this flow's `context.md` research notes). Every tracked job is
  SIGTERM→SIGKILL'd on `keryx shell`/TUI session exit — no orphaned
  processes survive the session.
- Approval: `background: true` goes through the exact same gate as any other
  `shell_exec` call (`ask`/`trust`/`auto`, destructive/credentials floor
  unchanged) — no separate, stricter gate for backgrounding.

**TUI / human-facing layer** (mirrors the Subagent Inspector, flow 162,
file-for-file):
- `src/tui/job-bridge.ts` (mirrors `subagent-bridge.ts`): a module-level
  `emitBackgroundJob`/`setBackgroundJobListener` pair the harness runner
  calls with lifecycle (`upsert`) and incremental stdout/stderr (`log`)
  events as they arrive — genuinely live, not just polled-on-demand.
- `src/tui/background-job-session.ts` (mirrors `subagent-session.ts`): a
  `BackgroundJobStore` — reactive, `subscribe()`-based, holding id/command/
  pid/status/startedAt/endedAt/exitCode + a bounded ring of output events
  (mirrors `MAX_SUBAGENT_EVENTS`/`MAX_SUBAGENT_EVENT_CHARS`). **Differs from
  `SubagentSessionStore` in one deliberate way**: entries do NOT clear on a
  new turn/`/clear` — a background job is explicitly meant to outlive the
  turn that started it. It clears only on explicit kill or session exit.
- `src/tui/background-job-inspector.ts` (mirrors `subagent-inspector.ts`):
  `paintBackgroundJobSidebar` (clickable rows, `onMouseDown` → `onOpen(id)`)
  + `openJobInspector` (modal via the shared `openModal` from
  `modal-host.ts`, tabs `Output`/`Meta`, live-refreshes via `subscribe()`,
  footer adds a `k: kill` action calling `shell_job_kill` through the same
  approval-free path as the tool).
- New sidebar section "Background Jobs N" wired into `tui-shell.ts` next to
  the existing Directory/Activity/Subagents panels.

**Resolved design tension** (from the prior research/discussion round): the
sidebar+modal gives the human a persistent, low-friction way to check a
job's live output without the model needing Claude-Code-style recurring
per-turn text reminders (the single most-reported bug against Claude Code's
own backgrounding feature — issues #11190/#11716/#13249, reminders that
outlive the job's actual status). keryx therefore mentions a started job
**once**, in the `shell_exec` tool result and description, and relies on the
system prompt's existing "persistence" instruction (recently added,
`buildAgentSystemInstruction`) plus the sidebar for human visibility — no
unconditional per-turn injected reminder.

## Out of Scope

- Push/event-driven model wakeup on new output (Codex's `wake_on_output`
  proposal) — not shipped anywhere in the surveyed prior art; a real
  platform investment, not this flow.
- Detaching a job so it survives the `keryx shell`/TUI session itself
  exiting (tmux-style). Explicitly rejected in the design discussion: job
  lifetime is scoped to the session, full stop.
- Any change to the synchronous (non-background) `shell_exec` path,
  `DEFAULT_SHELL_TIMEOUT_MS`, or the OS-sandbox wrapping it already does —
  background jobs reuse that machinery, this flow does not touch it.
- readline REPL (`commands/shell.ts`) sidebar/modal support — the TUI
  (`tui/tui-shell.ts`) is the only surface with a sidebar; the readline
  fallback gets the harness/tool layer (jobs work, are listable via
  `shell_job_output`) but no visual panel.
