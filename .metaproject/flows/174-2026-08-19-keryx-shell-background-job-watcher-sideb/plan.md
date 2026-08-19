# Implementation Plan

Status: ready for freeze (rescoped — single slice, see description.md)

## Approach

Mirror the `spawn_subagent` → `WorkerFleet` sidebar pattern exactly, with a
sibling bridge instead of touching `subagent-bridge.ts` (keeps job and
subagent event streams independently testable), and reuse `shell-exec-tool.ts`'s
approval/sandbox machinery instead of a parallel, weaker execution path.

- New `src/tui/job-bridge.ts`: `JobFleetEvent` (upsert/log/remove — same
  shape as `SubagentFleetEvent` in `subagent-bridge.ts`), `setJobFleetListener`
  / `emitJobFleet`. The TUI shell subscribes both bridges into the same
  `WorkerFleet` instance so jobs and subagents show together in one Activity
  panel; ids namespaced `job:<n>` vs `subagent:<id>`.
- New `src/harness/tool/builtin/background-job-tool.ts`, modeled directly on
  `shell-exec-tool.ts` (same `applySavedApiKeys`, same `KERYX_SANDBOX_SHELL`
  posture via `resolveShellSandboxMode`/`shellSandboxProfile`/
  `wrapWithSandbox` — a background job is still arbitrary command execution
  and must not get a weaker security posture than `shell_exec`). Four tools:
  - `start_job({ command, label? })` — risk `"shell"` (same default-deny
    approval gate as `shell_exec`; no bypass). `Bun.spawn`s the command,
    registers it in an in-module job registry (id, pid, `Bun.spawn` handle, a
    bounded ring buffer for recent stdout/stderr lines), emits `job-bridge`
    `upsert` with `status:"running"`, and **returns immediately** (does not
    await completion — this is what makes it useful alongside a running
    agent turn, unlike `shell_exec`). Stdout/stderr are read incrementally
    (same pattern as `shell-exec-tool.ts`'s `readInto`); each completed line
    updates the ring buffer and throttles a fleet `upsert` with `detail` =
    last non-empty line, so the sidebar shows a live tail without a
    repaint-per-byte. On exit, emits `status: "done"` (exit 0) or `"failed"`
    (non-zero/signal) with the exit summary as `detail`; the entry stays in
    the fleet (not auto-removed like the ephemeral side worker — the point is
    to see a watcher's outcome) until `stop_job` or the next shell start
    clears it.
  - `job_output({ id, tail? })` — risk `"read"`. Returns the job's current
    status plus the last `tail` (default e.g. 50) buffered lines. This is the
    on-demand "go look at what happened" step — matching events never push
    into the transcript on their own (confirmed with the user).
  - `list_jobs()` — risk `"read"`. id/label/status/pid for every job still
    tracked (running + finished-but-not-cleared).
  - `stop_job({ id })` — risk `"shell"` (terminates a process, but only ever
    one `start_job` itself minted this session — no arbitrary PID input).
    SIGTERM then SIGKILL after a short grace window, mirroring
    `shell-exec-tool.ts`'s deadline-kill logic; updates fleet status to
    `"done"` with `detail:"stopped"`.
  - `watch_job({ command, description, persistent?: boolean, timeout_ms?: number })`
    — risk `"shell"`, same approval/sandbox path as `start_job`. Matches
    Claude Code's own `Monitor` tool shape: `command` is typically an
    agent-authored filter pipeline (`tail -f build.log | grep --line-buffered
    -E "FAIL|Error"`); each COMPLETE stdout line is one event, appended to a
    bounded ring buffer of recent events (not raw byte tail — this is the
    difference from `start_job`). `persistent: true` runs until `stop_job`
    or shell exit; otherwise `timeout_ms` bounds it (default 300_000, cap
    3_600_000, mirroring Claude Code's `Monitor`) and it is killed on expiry
    with status `"done"`/`"timeout"`. Per the user's confirmed choice, an
    event updates the sidebar (`detail` = last event text + running event
    count) and is NEVER pushed into the transcript by itself — the one
    deliberate divergence from Claude Code's `Monitor`, which posts a chat
    notification per event. The tool description should carry the same
    "merge stderr with `2>&1`, filters must flush per line (`grep
    --line-buffered`)" guidance Claude Code's own `Monitor` description
    gives, since the failure mode (buffered output looks silent) is
    identical here.
  - `start_job` and `watch_job` share one job registry/id namespace
    (`job:<n>`), so `job_output`/`list_jobs`/`stop_job` work uniformly across
    both kinds; the registry entry carries `kind: "job" | "watch"` so
    `job_output` knows whether to return a raw tail or the event buffer.
  - A small concurrent-job cap (e.g. 8, counting both kinds together) refuses
    further `start_job`/`watch_job` calls with a clear, non-throwing error
    rather than growing unbounded.
  - **Process lifecycle**: every job still tracked as running is killed when
    the shell process exits (normal exit, Ctrl+C, and best-effort on crash)
    — no orphaned children survive the shell. A registry-level `killAll()` is
    wired into the TUI shutdown path and readline's exit path.
- Register the four tools alongside `shellExecTool` wherever
  `buildInteractiveAgentTools` composes the toolset today, so both shells get
  them (TUI shows the fleet live; readline can still `list_jobs`/`job_output`
  as text, no sidebar).

## Steps

1. `src/tui/job-bridge.ts` (new, mirrors `subagent-bridge.ts`).
2. `src/harness/tool/builtin/background-job-tool.ts` (new): job registry +
   four tools, reusing `shell-exec-tool.ts`'s sandbox/approval helpers rather
   than duplicating them (extract the shared pieces if duplication would
   otherwise be more than trivial).
3. Wire tool registration into `buildInteractiveAgentTools` (wherever
   `shellExecTool` is composed today) for both shells.
4. TUI wiring: subscribe `job-bridge` into the same `WorkerFleet` the shell
   already subscribes `subagent-bridge` into; wire `killAll()` into shell
   shutdown (TUI + readline exit paths).
5. Tests: approval/sandbox parity with `shell_exec`, fleet upsert
   transitions (running → done/failed), concurrency cap, kill-on-exit,
   `job_output`/`list_jobs` correctness.
6. `bun test --timeout 30000`, typecheck, lint on the working tree.

## Risks

- Orphaned background processes if `killAll()` wiring misses an exit path
  (Ctrl+C vs normal exit vs crash) — mitigated by an explicit AC + test per
  exit path this repo's TUI already distinguishes.
- `KERYX_SANDBOX_SHELL` posture must not be weaker for `start_job` than for
  `shell_exec` — checked explicitly in review, not just implemented and
  assumed correct.
- `keryx` on PATH is a stale build
  (`.metaproject/memory/constraints/stale-installed-keryx-binary.md`) —
  verification runs against the working tree (`bun test`), never the
  installed CLI.
