---
Title: "Supervised Shell Tasks (formerly Background Shell Jobs)"
Version: 2.0.0
Type: architecture
Status: accepted
Summary: ""
---
```markdown
---
Title: "Supervised Shell Tasks (formerly Background Shell Jobs)"
Version: 2.0.0
Type: architecture
Status: accepted
Summary: "Every `shell_exec` call is a supervised task that returns within a bounded yield. Commands finishing inside the yield behave synchronously; commands still running are transparently demoted to background tasks. The agent is notified of task completion exactly once, without polling. Full process-group ownership, sandbox parity with synchronous execution, and operator visibility via a TUI sidebar."
---

# Supervised Shell Tasks (formerly Background Shell Jobs)

This document describes the supervised shell task architecture, which transforms every `shell_exec` call into a managed background task without requiring explicit opt-in from the model.

**Key files:**

- `src/harness/tool/builtin/background-job-registry.ts`
- `src/harness/tool/builtin/shell-exec-tool.ts`
- `src/commands/agent.ts`
- `src/commands/agent-commands.ts`
- `src/commands/interactive-agent-tools.ts`
- `src/tui/background-job-inspector.ts`
- `src/tui/background-job-session.ts`
- `src/tui/job-bridge.ts`

## Summary

**Every `shell_exec` call is a supervised task.** The call returns within a bounded yield (`KERYX_SHELL_YIELD_MS`, 10 s by default): a command that finishes inside the yield returns its output exactly as a blocking call would, while one still running when the yield elapses keeps running as a background task and hands back `{task_id, pid, status, output}` instead of freezing the turn. Backgrounding is not a mode the model has to choose — it is what happens to any command that turns out to be slow. The model cannot forget to ask for it.

### Task Lifecycle and Termination

A task is killed for going **silent**, not for taking long. The idle threshold is `KERYX_SHELL_IDLE_MS` (120 seconds since the last output), which handles long-running commands that produce periodic output correctly.

Task identifiers follow the format `task-<n>-<pid>`. Terminal statuses are:

| Status | Meaning |
|--------|---------|
| `completed` | Exited with code 0 |
| `failed` | Exited with a non-zero code |
| `killed` | Terminated by a kill signal |

A kill always carries a `killReason` explaining why termination was requested:

- `model` — the model requested the kill via `shell_task_kill`
- `operator` — the operator used `/demote` or the TUI kill button
- `idle` — the idle timeout expired (`KERYX_SHELL_IDLE_MS`)
- `output-cap` — output exceeded `MAX_BACKGROUND_OUTPUT_BYTES`
- `session-exit` — the parent session is shutting down
- `hold-timeout` — an unattendended session exceeded `KERYX_SHELL_HOLD_MS`

This distinction ensures a task that was given up on is never confused with one that failed on its own.

### Completion Delivery

**A finished task reports itself exactly once.** The agent does not have to poll: when a task ends, its outcome is delivered as one `<task-notification>` block at a round boundary, carrying status, exit code, kill reason, duration, and the tail of its output.

**Session behavior on completion:**

- **Unattended sessions** (`--print`, no operator present) hold the turn open rather than exiting and leaving the result to nobody. An idle interactive session is woken by the completion, behind a cap that operator input resets.

### Model-Facing Task Tools

The model can read output, wait for exit, and steer tasks:

| Tool | Input | Behavior |
|------|-------|----------|
| `shell_task_output` | `{ task_id, since? }` | Returns output after an explicit cursor, the task's status, and the next cursor. Two calls with the same `since` return the same bytes (safe to retry, safe to share). Reports when older output was dropped before the requested cursor. |
| `shell_task_wait` | `{ task_ids, mode: "any" \| "all", timeout_ms? }` | Waits for task exit under a clamped bound (max 300,000 ms). Reaching the bound returns each task's status without killing. Interruptible: the turn's abort ends the wait and leaves every task running. |
| `shell_task_kill` | `{ task_id }` | Sends SIGTERM to the task's process group. Idempotent by refusal: asking again after the task ended reports its status, and a task that exited cleanly is not relabelled `killed`. |

> **Deprecated aliases:** `shell_job_output` and `shell_job_kill` remain as deprecated aliases for one release. Old `job-<n>-<pid>` identifiers resolve to `task-<n>-<pid>` for reads only. This spelling swap preserves the counter and PID, preventing a recycled PID from letting a stale ID land on a live task.

### Operator Levers

- **`/demote <task_id>`** in both shells moves a running foreground command to the background without stopping it and without ending the turn. It is in the TUI's busy-dispatch allow-list on purpose: a turn blocked on its own long command is precisely when an operator wants the command set aside.

- **Interrupting a turn releases the wait, not the work.** The turn's abort signal reaches a waiting tool (`shell_exec`'s yield, `shell_task_wait`); the task is promoted, keeps running with its output intact, and its completion is still delivered afterwards.

### Design Notes

There is no wait on a **condition**, and the distinction matters: a dev server or `tail -f` never exits, so every wait on one runs out its budget and returns statuses. To learn that such a task has reached some state — a port bound, a line logged — the model reads its output and looks, which costs a round each time. Whether that cost is worth an `until_output` predicate is deliberately parked in [`docs/requirements/keryx-task-monitoring/`](../../../docs/requirements/keryx-task-monitoring/README.md).

A TUI layer gives the human the same visibility without relying on the model to keep reporting back: a sidebar panel (labeled "Background Jobs N"), with clickable rows opening a live-updating Output/Meta modal. A task appears there only once it is actually in the background, so a command that finishes inside its yield never flickers through the list.

### Implementation Phases

This page describes the model as it stands after phases P0–P2 of `docs/requirements/keryx-background-task-execution/` (flows 263, 265, 266; released in 0.2.108–0.2.110). It began as flow 173's opt-in `background: true` capability, and the parts of that design that survived — process-group ownership, sandbox reuse, the unchanged approval gate, session-scoped lifetime, and the bounded-resource rails — are described below as current behavior rather than history.

## Details

### Harness Layer: `JobRegistry`

`src/harness/tool/builtin/background-job-registry.ts` owns a session-scoped map of tracked tasks. Its core operations:

| Operation | Description |
|-----------|-------------|
| `start` / `get` / `list` / `kill` / `sweepAll` | Task lifecycle management (flow 173 API) |
| `waitForExit` / `promote` | Bounded yield — promotes rather than kills on timeout |
| `readOutput` | Output read from an implicit cursor |
| `readOutputSince` | Output read from an explicit, absolute cursor |
| `drainUndelivered` / `markObserved` / `onCompletion` | Completion delivery bookkeeping |

**Session scoping.** One `JobRegistry` instance is created outside `makeAgentDeps`/`buildInteractiveAgentTools`'s per-turn tool-list rebuild and threaded through every call for that session. This mirrors the existing `getSessionDir`/`slateSessionBox` pattern. `buildInteractiveAgentTools` does **not** mint a fallback registry when the caller omits one — the task tools are simply absent from that session's tool list, and `shell_exec` keeps the plain synchronous runner (D-17). Capability-absent is safer than capability-present-but-orphaned.

### Process-Group Ownership

The default spawner passes `detached: true` to `Bun.spawn`, making the direct child a fresh process-group leader (POSIX `setsid` semantics — confirmed empirically on Bun 1.3.14/macOS). Every kill path signals `-pid` (negative — "the whole process group"), never a bare PID, so a grandchild the command backgrounds and forgets about (`sh -c 'cmd &'`) is reached too.

This closes the exact process-ownership bug class hit live by other tools (FD-inheritance hangs, sandboxed-`pgrep` blindness) — losing track of the group, not just the direct child, is the actual common failure mode across surveyed prior art.

### Sandbox Reuse

The background spawner goes through the identical `resolveShellEnv`/`resolveSandboxedSpawn` sandbox-mode resolution, fail-closed launcher refusal, restricted-network masking, and credential/env setup as the synchronous path. These are extracted into shared functions both paths call, not a parallel reimplementation. A background job under `KERYX_SANDBOX_SHELL=strict` gets the same containment as a synchronous one.

### Bounded Resources

| Constant | Default | Behavior |
|----------|---------|----------|
| `MAX_CONCURRENT_BACKGROUND_JOBS` | 3 | Caps only *running* jobs; exceeding it is a visible tool error naming the current jobs |
| `MAX_BACKGROUND_OUTPUT_BYTES` | 2 MB | Per-job output ring; a job exceeding it is auto-killed (one SIGTERM, guarded against re-firing during grace period) |
| `MAX_TRACKED_JOBS` | — | LRU-evicts the oldest *terminated* job once running + finished exceeds the bound; a running job is never evicted |
| `MAX_OUTPUT_BYTES` | — | Auto-kill rail; truncated buffer shrinks to a short tail after exit delivery |

`readOutput`'s cursor is rebased whenever the buffer is truncated, so a poll after truncation returns the correct remaining tail instead of silently skipping or blanking output.

### Terminal Status Derivation

Terminal status is derived from intent, not from which signal won. A `killRequested` flag is set the moment `kill()`/`sweepAll()` signals a job; the real process-exit handler sets the final status — `"killed"` if the flag is set, otherwise `"completed"` on exit code 0 and `"failed"` on any other — regardless of whether the process died from SIGTERM or needed SIGKILL. Exactly one `exit` event fires per job.

### Completion Delivery: The Agent Is Told, It Does Not Have to Ask

A task needs telling about only if its handle was returned (it reached the `background` phase) and nobody has seen its outcome yet. `drainUndelivered()` returns exactly those and marks them observed in the same synchronous step, so a replayed or concurrent drain delivers nothing twice.

**What counts as being told:**

- Reading a task that has ALREADY finished counts as being told
- Reading a task that is still running does NOT count (nothing about its outcome was reported)
- A kill the model or the operator asked for counts
- The `idle` and `output-cap` rails do NOT count (nobody asked for those)

**Message shape:** One `role: "user"`, `provenance: "tool"` message per drain, coalescing every finished task: a `<task-notification>` envelope each, carrying `task_id`, `status`, `exit_code`, `kill_reason`, `duration_ms`, and up to 4,000 bytes of output tail per task. The banner states the text is command output, not instructions from the user. It does not latch the untrusted-content gate.

**Timing:** Completion notifications are pushed only at a round boundary, after every `tool` result of a batch — never between two results answering one `tool_calls` batch.

**Two delivery modes:**

1. **Unattended sessions** (`--print`, `unattended`) hold the turn open rather than ending it while one of its own tasks runs. The bound is `KERYX_SHELL_HOLD_MS` (default 1,800,000 ms — 30 minutes); a task still running past it is killed with `killReason: "hold-timeout"` and reported in that final round.

2. **Interactive sessions** wake instead: the readline REPL races its next input line against the next completion, and the TUI starts a turn only when no foreground operation is active and the operator queue is empty. Consecutive completion-started turns are capped by `KERYX_SHELL_MAX_AUTO_WAKE` (default 5); any operator line resets the count. Past the cap, the pending result is surfaced and delivered with the next message.

Both knobs follow the project's fail-safe pattern: unset, empty, malformed, and negative values fall back to the default; an explicit `0` disables.

### Tool Safety and Budget

`shell_task_output` and `shell_task_kill` (and their deprecated aliases) are both `risk: "read"` — no approval prompt. The safety argument: they can only ever target a `task_id` already present in the **calling session's own** registry, so none can do anything beyond what the already-approved `shell_exec` call authorized. There is no path to an arbitrary OS PID. This was adversarially reviewed and holds — with one exception that needed a separate fix (see "Side-worker exception" below).

**Repeatability exemption.** `shell_task_output` is exempted from the per-turn tool-call hash-attempt cap (`REPEATABLE_TOOL_NAMES`). Its whole purpose is being called repeatedly with identical input, which would otherwise hash-collide with itself and hit the loop-safety cap after 3 calls. `shell_task_kill` is deliberately **not** exempted — repeated kill attempts are a different risk profile than repeated reads.

**Side-worker exception.** A read-only side worker (spawned via `spawn_subagent` or the TUI's own side-worker rebuild) gets its tool list filtered to `risk === "read"` tools — which would hand it kill and wait tools too, letting a lesser-trusted context end or block on tasks it never approved. `SIDE_WORKER_DENIED_TOOL_NAMES` excludes them by name:

- `shell_task_kill`
- `shell_job_kill`
- `shell_task_wait`
- `shell_job_output`

`shell_task_output` is deliberately NOT denied because its cursor is explicit — a side worker reading a task cannot consume output the main session has not seen. Only tools built for the main session mark a task as delivered. The side worker's copy is built with `observer: "side"` and never marks, so a helper glancing at a finished task cannot make the main session's completion notification disappear.

**Tool-call budget.** The task tools are `risk: "read"` for the existing purpose `risk` already served: the split between a small non-read tool-call pool (`shell_exec`, `spawn_subagent`, …) and a much larger read-tool pool. Reading or waiting on a task draws from the large pool, not the scarce one.

**Approval.** Every `shell_exec` call goes through the same `resolveApprovalDecision` gate, in all three permission modes (`ask`/`trust`/`auto`), including the destructive/credentials hard floor. A command that outlives its yield and becomes a background task was approved once, as the command it is — there is no separate, stricter gate for backgrounding, and none for the task tools.

### Session Lifecycle: Every Job Dies with Its Session

Background jobs deliberately do **not** outlive the `keryx shell`/TUI session that started them. This is a hard, non-negotiable design line. Every real exit path sweeps both:

- **OS-level registry:** `JobRegistry.sweepAll()` — SIGTERM→SIGKILL by process group
- **TUI-side store:** `BackgroundJobStore.removeAll()`

Real exit paths include: readline EOF, `/exit`/`/quit`, the TUI's `/exit` (both idle and busy-dispatch branches), and Ctrl+C via `onDestroy`.

**`/clear` and `/new` deliberately do *not* sweep.** This is the flow's central design tension: a background job is meant to outlive the *turn* that started it. `BackgroundJobStore` has **no `clear()` method** — only `removeAll()`, a distinctly-named teardown meant to be called from exactly the real session-exit paths. This is a deliberate divergence from `SubagentSessionStore` (flow 162), whose `clear()` resets on every new turn and on `/clear`/`/new`. Adding a `clear()` equivalent to `BackgroundJobStore` would invite exactly that call site to be added later, silently reintroducing the bug this flow's design exists to avoid.

A naturally-exited or killed job's entry is **not** auto-removed from the store on its own exit event — it stays visible with its terminal status and `exitCode`/`endedAt` until `removeAll()`. The human very likely wants to see a finished job's final output and exit code in the inspector.

### TUI Layer: Sidebar and Inspector

Structural mirror of the Subagent Inspector (flow 162), file for file:

| Subagent (flow 162) | Background job (flow 173) |
|---------------------|---------------------------|
| `subagent-bridge.ts` | `src/tui/job-bridge.ts` — module-level `emitBackgroundJob`/`setBackgroundJobListener`, a safe no-op when no TUI is mounted |
| `subagent-session.ts` (`SubagentSessionStore`) | `src/tui/background-job-session.ts` (`BackgroundJobStore`) — no `clear()`, see above |
| `subagent-inspector.ts` | `src/tui/background-job-inspector.ts` — `paintBackgroundJobSidebar` (clickable rows, `onMouseDown` → open) + `presentJobInspector`/`openJobInspector` (modal via shared `openModal`, tabs `Output`/`Meta`, footer adds a clickable `[Kill]` row calling the same `JobRegistry.kill()` the model-facing tool uses) |

**Wiring:** `shell.ts` wires `createJobRegistry({..., onEvent: emitBackgroundJob})` for the TUI-facing registry only. The readline registry has no listener to feed. `tui-shell.ts` mounts a "Background Jobs N" panel next to the existing Directory/Activity/Subagents panels, guards its repaint on `hint?.kind !== "output"` (mirroring the sibling `paintSubagents` guard), so a chatty job's output stream does not repaint and potentially destroy a mid-click renderable under the sidebar on every chunk.

## Prior Art

Surveyed before designing this: other agent CLIs, plus non-AI job control (`tmux`, `&`+`jobs`+`kill %1`, `systemd-run --user`+`journalctl -f`).

**Decisions made deliberately against or beyond prior art:**

- **Push on completion, not polling.** Flow 173 surveyed this and chose polling. Flow 265 reversed that decision (brainstorm D-02) once a reference implementation existed: a finished task now delivers its own outcome, and reading is a choice rather than the only channel. The poll-on-demand read survives as `shell_task_output`.

- **No recurring per-turn reminder.** The most-reported bug against this feature in other agent CLIs is a harness-injected "job still running" reminder that keeps firing even after the job finishes or is killed. keryx does not inject a recurring reminder at all: a running task produces no message, and a finished one produces exactly one. The single message now arrives when the task ends rather than when it starts.

- **Kill by process group, not bare PID.** FD-inheritance hangs and sandboxed-`pgrep` blindness are the same root bug from two different angles. This is the one requirement this flow treats as non-negotiable.

- **No stricter approval gate for backgrounding.** Every surveyed tool that gates approval at all reuses the same gate for foreground and background. keryx does too, deliberately.

## Explicitly Out of Scope

- **Detaching a job so it survives session exit** (tmux-style). Rejected outright — job lifetime is scoped to the session, full stop.

- **Push on new output** (a streaming `monitor` tool). Still out of scope, and distinct from what flow 265 shipped: completion delivery is one message per task when it ends, not a stream of its output into the turn.

- **A visual sidebar/inspector for the readline REPL.** Readline gets the harness/tool layer in full (jobs work, are pollable/killable) but no visual panel — there is no sidebar surface to mount one in.

- **Changes to the synchronous `shell_exec` path's own behavior.** No longer true. There is no separate synchronous path anymore. Every call goes through the bounded yield, and the wall-clock `DEFAULT_SHELL_TIMEOUT_MS` deadline was replaced by the idle timeout. A command that finishes inside the yield still returns the synchronous-shaped result, keeping the common case unchanged.

## Related

- `src/harness/tool/builtin/background-job-registry.ts` — `JobRegistry`, the model-facing task tools, and all bounded-resource constants
- `src/harness/tool/builtin/shell-exec-tool.ts` — the synchronous path and shared sandbox setup functions
- `src/commands/agent.ts` — the read/non-read tool-call budget split, `REPEATABLE_TOOL_NAMES`, `AgentDeps.sweepBackgroundJobs`/`jobRegistry`
- `src/commands/interactive-agent-tools.ts` — the single factory both readline and TUI build their tool lists from
- `src/commands/shell.ts` / `src/tui/tui-shell.ts` — session-scoped registry creation, exit-sweep call sites, side-worker tool-filter exception
- `src/tui/job-bridge.ts` — event emission bridge for the TUI
- `src/tui/background-job-session.ts` — `BackgroundJobStore`, the TUI-side job persistence
- `src/tui/background-job-inspector.ts` — the TUI sidebar panel and inspector modal
- [Permission Modes](permission-modes.md) — the approval gate this flow reuses unchanged
- [OS Sandbox](os-sandbox.md) — the containment layer the background path shares with the synchronous path
```
