# Supervised Shell Tasks (formerly Background Shell Jobs)

Version: 2.0.0
Type: architecture
Status: accepted
Describes:
  - src/harness/tool/builtin/background-job-registry.ts
  - src/harness/tool/builtin/shell-exec-tool.ts
  - src/commands/agent.ts
  - src/commands/agent-commands.ts
  - src/commands/interactive-agent-tools.ts
  - src/tui/background-job-inspector.ts
  - src/tui/background-job-session.ts
  - src/tui/job-bridge.ts

## Summary

**Every `shell_exec` call is a supervised task.** The call returns within a
bounded yield (`KERYX_SHELL_YIELD_MS`, 10 s): a command that finishes inside it
returns its output exactly as a blocking call would, and one still running when
the yield elapses keeps running as a background task, handing back
`{task_id, pid, status, output}` instead of freezing the turn. Backgrounding is
not a mode the model has to choose — it is what happens to any command that
turns out to be slow, which is the point: the model cannot forget to ask for it.

A task is killed for going SILENT, not for taking long (`KERYX_SHELL_IDLE_MS`,
120 s since the last output). Ids are `task-<n>-<pid>`; terminal statuses are
`completed` (exit 0), `failed` (non-zero) and `killed`, and a kill carries a
`killReason` — `model`, `operator`, `idle`, `output-cap`, `session-exit` or
`hold-timeout` — so a task that was given up on is never confused with one that
failed on its own.

**A finished task reports itself, exactly once.** The agent does not have to
poll: when a task ends, its outcome is delivered as one `<task-notification>`
block at a round boundary, carrying status, exit code, kill reason, duration and
the tail of its output. A session nobody can wake (`--print`, unattended) holds
its turn open rather than exiting and leaving the result to nobody; an idle
interactive session is woken by the completion, behind a cap that operator input
resets.

**The model can read, wait for EXIT, and steer.** `shell_task_output` reads from
an explicit cursor, `shell_task_wait` waits for `any`/`all` of a set to EXIT
under a clamped bound, and `shell_task_kill` stops a task's process group. An
interrupt ends a WAIT and never the command. The operator can move a running
command aside with `/demote <task_id>` in both shells, including while the turn
is busy.

There is no wait on a CONDITION, and the distinction matters for the workload
this page opens with: a dev server or a `tail -f` never exits, so every wait on
one runs out its budget and returns statuses. To learn that such a task has
reached some state — a port bound, a line logged — the model reads its output
and looks, which costs a round each time. Whether that cost is worth a
`until_output` predicate is specified and deliberately parked in
[`docs/requirements/keryx-task-monitoring/`](../../../docs/requirements/keryx-task-monitoring/README.md).

A TUI layer gives the human the same visibility without relying on the model to
keep reporting back: a sidebar panel (still labelled "Background Jobs N" in the
interface — the code's own name for it), with clickable rows opening a
live-updating Output/Meta modal. A task appears there only once it is actually in
the background, so a command that finishes inside its yield never flickers
through the list.

This page describes the model as it stands after phases P0–P2 of
`docs/requirements/keryx-background-task-execution/` (flows 263, 265, 266;
released in 0.2.108–0.2.110). It began as flow 173's opt-in `background: true`
capability, and the parts of that design that survived — process-group
ownership, sandbox reuse, the unchanged approval gate, session-scoped lifetime
and the bounded-resource rails — are described below as current behaviour rather
than as history.

This covers the "run a dev server / tail a log and keep working" capability
other agentic CLIs expose (Claude Code's `run_in_background`/`BashOutput`/
`KillShell` is the closest analog), but arrives at it from the other side: there
is no flag to remember, because every command is already a task — see "Prior art"
below for what was deliberately or explicitly not copied.

### Model-facing task tools

| Tool | Input | What it does |
|---|---|---|
| `shell_task_output` | `{ task_id, since? }` | Output after an EXPLICIT cursor, plus the task's status and the next cursor. Two calls with the same `since` return the same bytes, so it is safe to retry and safe to hand to a second reader. Says when older output was dropped before the requested cursor rather than returning it as new. |
| `shell_task_wait` | `{ task_ids, mode: "any"\|"all", timeout_ms? }` | Waits deliberately instead of polling in a loop. `timeout_ms` is clamped to at most 300 000; reaching the bound returns each task's status and NEVER kills. Interruptible: the turn's abort ends the wait and leaves every task running. |
| `shell_task_kill` | `{ task_id }` | Process-group kill. Idempotent by refusal: asking again after the task ended reports its status instead of signalling, and a task that exited cleanly is not relabelled `killed`. |

`shell_job_output` and `shell_job_kill` remain as DEPRECATED aliases for one
release and say so in the descriptions the model receives. An id written in the
old `job-<n>-<pid>` spelling resolves to its `task-` equivalent for READS only:
every id in a live session is `task-*`, so a `job-*` id can only come from an
earlier session — a dead reference by design (tasks do not survive a session) —
and the spelling swap preserves the counter and the pid, so a recycled pid could
otherwise let a stale id land on a live task. A wrong read is a wrong answer; a
wrong kill destroys work, so the acting tools take the id exactly as given.

### The operator's levers

- **`/demote <task_id>`** in both shells moves a running foreground command to
  the background without stopping it and without ending the turn. It is in the
  TUI's busy-dispatch allow-list on purpose: a turn blocked on its own long
  command is precisely when an operator wants the command set aside.
- **Interrupting a turn releases the WAIT, not the work.** The turn's abort
  signal reaches a waiting tool (`shell_exec`'s yield, `shell_task_wait`); the
  task is promoted, keeps running with its output intact, and its completion is
  still delivered afterwards.

## Details

### Harness layer: `JobRegistry`

`src/harness/tool/builtin/background-job-registry.ts` owns a session-scoped
map of tracked tasks. Its surface: `start`/`get`/`list`/`kill`/`sweepAll` from
flow 173; `waitForExit` and `promote` (the bounded yield, which promotes rather
than kills on timeout); `readOutput` for the implicit cursor and
`readOutputSince` for the explicit, absolute one; and the delivery bookkeeping
`drainUndelivered`/`markObserved`/`onCompletion`, which is what makes a
completion reach the agent exactly once.
Session-scoped means ONE instance is created outside `makeAgentDeps`/
`buildInteractiveAgentTools`'s per-turn tool-list rebuild and threaded
through every call for that session (`src/commands/shell.ts`, both the
readline agent branch and the TUI `makeAgentDeps` closure) — mirrors the
existing `getSessionDir`/`slateSessionBox` pattern. `buildInteractiveAgentTools`
(`src/commands/interactive-agent-tools.ts`) does **not** mint a fallback
registry when the caller omits one: the task tools and their aliases are simply
absent from that session's tool list in that case, and `shell_exec` keeps the
plain synchronous runner (D-17) — capability-absent is safer than
capability-present-but-orphaned. Both production call sites pass a registry.

**Process-group ownership.** The default spawner passes `detached: true` to
`Bun.spawn`, making the direct child a fresh process-group leader (POSIX
`setsid` semantics — confirmed empirically on Bun 1.3.14/macOS, see the
flow's journal for the spike). Every kill path signals `-pid` (negative —
"the whole process group"), never a bare PID, so a grandchild the command
backgrounds and forgets about (`sh -c 'cmd &'`) is reached too. This closes
the exact process-ownership bug class hit live by other tools (opencode's
FD-inheritance hangs, Codex's sandboxed-`pgrep` blindness) — losing track of
the group, not just the direct child, is the actual common failure mode
across surveyed prior art, not the API shape.

**Sandbox reuse.** The background spawner goes through the identical
`resolveShellEnv`/`resolveSandboxedSpawn` sandbox-mode resolution,
fail-closed launcher refusal, restricted-network masking, and credential/env
setup as the synchronous path (`shell-exec-tool.ts`'s `makeCommandRunner`) —
extracted into shared functions both paths call, not a parallel
reimplementation. A background job under `KERYX_SANDBOX_SHELL=strict` gets
the same containment as a synchronous one.

**Bounded everything.**
- `MAX_CONCURRENT_BACKGROUND_JOBS` (default 3, `KERYX_MAX_BACKGROUND_JOBS`
  override) caps only *running* jobs; exceeding it is a visible tool error
  naming the current jobs, never a silent queue or eviction.
- `MAX_BACKGROUND_OUTPUT_BYTES` (2MB) is a per-job output-ring cap; a job
  that exceeds it is auto-killed (one SIGTERM, guarded against re-firing
  during the grace period) rather than buffering forever — mirrors Claude
  Code's own (much larger) output-cap auto-kill rail.
- `MAX_TRACKED_JOBS` LRU-evicts the oldest *terminated* job once the total
  job count (running + finished) exceeds the bound — a running job is never
  eligible — and a terminated job's output buffer is shrunk to a short tail
  once its exit event has been delivered, so a long session accumulating
  many short-lived jobs doesn't grow unbounded.
- `readOutput`'s cursor is rebased whenever the buffer is truncated (both
  the auto-kill rail and the tail-shrink path), so a poll after truncation
  returns the correct remaining tail instead of silently skipping or
  blanking output.

**Terminal status is derived from intent, not from which signal won.** A
`killRequested` flag is set the moment `kill()`/`sweepAll()` signals a job;
the real process-exit handler (not the kill call site) sets the final status
— `"killed"` if the flag is set, otherwise `"completed"` on exit code 0 and
`"failed"` on any other — regardless of
whether the process died from SIGTERM or needed SIGKILL. Exactly one `exit`
event fires per job.

### Completion delivery: the agent is told, it does not have to ask

A task needs telling about only if its handle was returned (it reached the
`background` phase) and nobody has seen its outcome yet. `drainUndelivered()`
returns exactly those and marks them observed in the same synchronous step, so a
replayed or concurrent drain delivers nothing twice. Reading a task that has
ALREADY finished counts as being told; reading one that is still running does
not, because nothing about its outcome was reported. A kill the model or the
operator asked for counts too — but the `idle` and `output-cap` rails do not,
since nobody asked for those.

**Message shape.** One `role: "user"`, `provenance: "tool"` message per drain,
coalescing every finished task: a `<task-notification>` envelope each, carrying
`task_id`, `status`, `exit_code`, `kill_reason` and `duration_ms`, under a banner
stating the text is command output and not instructions from the user, with at
most 4 000 bytes of output tail per task. It does not latch the untrusted-content
gate.

**Where it is pushed.** Only at a round boundary, after every `tool` result of a
batch — never between two results answering one `tool_calls` batch, which some
providers reject outright.

**Two delivery modes.** A session that nobody can wake (`--print`,
`unattended`) HOLDS its turn open rather than ending it while one of its own
tasks runs: it waits, then continues the turn with the notification. The bound is
`KERYX_SHELL_HOLD_MS` (default 1 800 000 ms — 30 minutes); a task still running
past it is killed with `killReason: "hold-timeout"` and reported in that final
round. An interactive session WAKES instead: the readline REPL races its next
input line against the next completion, and the TUI starts a turn only when no
foreground operation is active and the operator queue is empty, so a typed
message always goes first. Consecutive completion-started turns are capped by
`KERYX_SHELL_MAX_AUTO_WAKE` (default 5) and any operator line resets the count;
past the cap the pending result is surfaced and delivered with the next message.
Both knobs follow the project's fail-safe pattern — unset, empty, malformed and
negative fall back to the default, an explicit `0` disables.

### Tool safety and budget

`shell_job_output`/`shell_job_kill` are both `risk: "read"` — no approval
prompt. The safety argument: they can only ever target a `task_id` already
present in the **calling session's own** registry, so none can do anything
beyond what the already-approved `shell_exec` call itself authorized; there is
no path to an arbitrary OS PID. This was
adversarially reviewed and holds — with one exception that needed a
separate fix, not a `risk` change (see "Side-worker exception" below).

`shell_job_output` is exempted from the per-turn tool-call hash-attempt cap
(`REPEATABLE_TOOL_NAMES` in `src/commands/agent.ts`'s `reserveToolAttempt`)
— its whole purpose is being called repeatedly with an identical input
(`{task_id}`), which would otherwise hash-collide with itself and hit the
loop-safety cap after 3 calls. `shell_job_kill` is deliberately **not**
exempted — repeated kill attempts are a different risk profile than
repeated reads and stay capped like any other tool.

**Side-worker exception.** A read-only side worker (spawned via
`spawn_subagent` or the TUI's own side-worker rebuild) gets its tool list
filtered to `risk === "read"` tools — which would hand it the kill and wait
tools too, letting a lesser-trusted context end or block on tasks it never
approved starting, by reference to the main session's live registry.
`SIDE_WORKER_DENIED_TOOL_NAMES` (exported from `src/tui/tui-shell.ts`) excludes
them by name alongside the `risk === "read"` check, and now holds four:
`shell_task_kill`, `shell_job_kill`, `shell_task_wait` and `shell_job_output`.
Their risk classification itself stays `"read"` (required for the tool-call
budget split below) because the fix is "stop trusting `risk` alone as a
safety boundary for this one existing consumer," not "reclassify the tool."

`shell_task_output` is deliberately NOT denied: its cursor is explicit, so a
side worker reading a task cannot consume output the main session has not seen.
The second half of that rule is subtler and is what keeps exactly-once delivery
true once a second reader exists — only tools built for the MAIN session mark a
task as delivered. The side worker's copy is built with `observer: "side"` and
never marks, so a helper glancing at a finished task can no longer make the main
session's completion notification disappear.

**Tool-call budget.** The task tools and their aliases are `risk: "read"` for
the *other* existing purpose `risk` already served: `src/commands/agent.ts`'s
split between a small non-read tool-call pool (`shell_exec`, `spawn_subagent`, …)
and a much larger read-tool pool. Reading or waiting on a task draws from the
large pool, not the scarce one.

`REPEATABLE_TOOL_NAMES` (exported from `src/commands/agent.ts`) exempts the
polling tools from the per-turn hash-attempt cap, and now holds three:
`shell_job_output`, `shell_task_output` and `shell_task_wait`. Following a
running command means calling with identical input, which would otherwise
hash-collide with itself and trip the loop-safety cap after three calls. The
kill tools are deliberately NOT exempted — repeated kill attempts are a different
risk profile than repeated reads and stay capped like any other tool.

**Approval.** Every `shell_exec` call goes through the same
`resolveApprovalDecision` gate, in all three permission modes
(`ask`/`trust`/`auto`), including the destructive/credentials hard floor. A
command that outlives its yield and becomes a background task was approved once,
as the command it is — there is no separate, stricter gate for backgrounding,
and none for the task tools, which can only ever reach a task in the calling
session's own registry. See [Permission Modes](permission-modes.md).

### Session lifecycle: every job dies with its session

Background jobs deliberately do **not** outlive the `keryx shell`/TUI
session that started them (no tmux-style detach) — this is a hard,
non-negotiable design line, not an oversight. Every real exit path sweeps
both the OS-level registry (`JobRegistry.sweepAll()` — SIGTERM→SIGKILL by
process group) and the TUI-side store (`BackgroundJobStore.removeAll()`):
readline EOF, `/exit`/`/quit`, the TUI's `/exit` (both the idle branch and
the mid-turn "busy" dispatch branch), and Ctrl+C (`onDestroy`, which fires
on Ctrl+C — `exitOnCtrlC: true` — via TDZ-safe live references since
`onDestroy` can't reliably be awaited).

**`/clear`/`/new` deliberately do *not* sweep.** This is the flow's central
design tension, made explicit: a background job is meant to outlive the
*turn* that started it (that's the entire point), so `BackgroundJobStore`
has **no `clear()` method at all** — only `removeAll()`, a distinctly-named
teardown meant to be called from exactly the real session-exit paths above.
This is a deliberate divergence from the older `SubagentSessionStore`
(flow 162), whose `clear()` resets on every new turn and on `/clear`/`/new`
— giving `BackgroundJobStore` an equivalent `clear()` would invite exactly
that call site to be added later, silently reintroducing the bug this
flow's design exists to avoid.

A naturally-exited or killed job's entry is **not** auto-removed from the
store on its own exit event — it stays visible with its terminal status and
`exitCode`/`endedAt` until `removeAll()`. The human very likely wants to see
a finished job's final output/exit code in the inspector, not have it
vanish the instant it exits.

### TUI layer: sidebar + inspector

Structural mirror of the Subagent Inspector (flow 162:
`subagent-bridge.ts`/`subagent-session.ts`/`subagent-inspector.ts`), file
for file:

| Subagent (flow 162) | Background job (flow 173) |
|---|---|
| `subagent-bridge.ts` | `src/tui/job-bridge.ts` — module-level `emitBackgroundJob`/`setBackgroundJobListener`, a safe no-op when no TUI is mounted (readline sessions never register a listener) |
| `subagent-session.ts` (`SubagentSessionStore`) | `src/tui/background-job-session.ts` (`BackgroundJobStore`) — no `clear()`, see above |
| `subagent-inspector.ts` | `src/tui/background-job-inspector.ts` — `paintBackgroundJobSidebar` (clickable rows, `onMouseDown` → open) + `presentJobInspector`/`openJobInspector` (modal via the shared `openModal`, tabs `Output`/`Meta` instead of `Work`/`Meta`, footer adds a clickable `[Kill]` row calling the SAME `JobRegistry.kill()` the model-facing tool uses — never a private second kill path) |

`shell.ts` wires `createJobRegistry({..., onEvent: emitBackgroundJob})` for
the TUI-facing registry only (the readline registry has no listener to feed
— `onEvent` there would be dead weight). `tui-shell.ts` mounts a "Background
Jobs N" panel next to the existing Directory/Activity/Subagents panels, uses
the same hug-content `BoxRenderable` idiom, and guards its repaint on
`hint?.kind !== "output"` (mirroring the sibling `paintSubagents` guard) so
a chatty job's output stream doesn't repaint — and potentially destroy a
mid-click renderable under — the sidebar on every chunk.

## Prior art

Surveyed before designing this (Claude Code, Codex CLI, Gemini CLI, aider,
opencode, Cline, plus non-AI job control: `tmux`/`&`+`jobs`+`kill %1`/
`systemd-run --user`+`journalctl -f`). Decisions this flow made deliberately
against or beyond that prior art:

- **Push on completion, not polling — decided against the prior art.** Flow 173
  surveyed this and chose polling, because Codex's `wake_on_output` was an open,
  unshipped proposal everywhere it was found. Flow 265 reversed that decision
  (brainstorm D-02) once a reference implementation existed: a finished task now
  delivers its own outcome, and reading is a choice rather than the only channel.
  The poll-on-demand read survives as `shell_task_output`, with an explicit
  cursor so a second reader cannot consume the first one's output.
- **No recurring per-turn reminder.** Claude Code's most-reported bug
  against this exact feature (issues #11190/#11716/#13249) is a harness-
  injected "job still running" reminder that keeps firing even after the
  job finishes or is killed — a lifecycle-tracking bug, not a design flaw
  in the reminder *concept*. keryx does not inject a recurring reminder at
  all: a RUNNING task produces no message whatsoever, and a finished one
  produces exactly one. That half of the decision survived flow 265 unchanged —
  what changed is that the single message now arrives when the task ENDS rather
  than when it starts, so noticing a long-forgotten task no longer rests on the
  model remembering to poll.
- **Kill by process group, not bare PID.** opencode's FD-inheritance hangs
  and Codex's sandboxed-`pgrep` blindness are the same root bug (losing
  the group) from two different angles — this is the one requirement this
  flow treats as non-negotiable, not a nice-to-have.
- **No stricter approval gate for backgrounding.** Every surveyed tool that
  gates approval at all reuses the same gate for foreground and background
  — keryx does too, deliberately, rather than inventing a new axis.

## Explicitly out of scope

- **Detaching a job so it survives session exit** (tmux-style). Rejected
  outright — job lifetime is scoped to the session, full stop.
- **Push on new OUTPUT** (a streaming `monitor` tool) — still out of scope, and
  distinct from what flow 265 shipped: completion delivery is one message per
  task when it ENDS, not a stream of its output into the turn.
- **A visual sidebar/inspector for the readline REPL** (`keryx shell`
  without the TUI). Readline gets the harness/tool layer in full (jobs
  work, are pollable/killable) but no visual panel — there is no sidebar
  surface to mount one in.
- ~~**Changes to the synchronous `shell_exec` path's own behavior.**~~ No longer
  true, and it is the largest thing flow 263 changed: there is no separate
  synchronous path any more. Every call goes through the bounded yield, and the
  wall-clock `DEFAULT_SHELL_TIMEOUT_MS` deadline was replaced by the idle
  timeout. A command that finishes inside the yield still returns the
  synchronous-SHAPED result, which is what keeps the common case unchanged for
  callers.

## Related

- `src/harness/tool/builtin/background-job-registry.ts` — `JobRegistry`,
  the two model-facing tools, all the bounded-resource constants.
- `src/harness/tool/builtin/shell-exec-tool.ts` — the synchronous path and
  the shared `resolveShellEnv`/`resolveSandboxedSpawn` sandbox setup both
  paths call.
- `src/commands/agent.ts` — the read/non-read tool-call budget split,
  `REPEATABLE_TOOL_NAMES`, `AgentDeps.sweepBackgroundJobs`/`jobRegistry`.
- `src/commands/interactive-agent-tools.ts` — the single factory both
  `keryx shell` (readline) and the TUI build their tool list from.
- `src/commands/shell.ts` / `src/tui/tui-shell.ts` — session-scoped
  registry creation, all real exit-sweep call sites, the side-worker
  tool-filter exception.
- `src/tui/job-bridge.ts`, `src/tui/background-job-session.ts`,
  `src/tui/background-job-inspector.ts` — the TUI layer.
- [Permission Modes](permission-modes.md) — the approval gate this flow
  reuses unchanged.
- [OS Sandbox](os-sandbox.md) — the containment layer the background path
  now shares with the synchronous path.
- [Wiki, Graph, and Shared Agent Context](wiki-graph-sac.md) — the
  Subagent Inspector this flow's TUI layer structurally mirrors is
  documented in `src/tui/CLAUDE.md`/flow 162, not a standalone wiki page at
  time of writing.
