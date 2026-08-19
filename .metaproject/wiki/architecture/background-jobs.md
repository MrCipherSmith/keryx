# Background Shell Jobs

Version: 1.0.0
Type: architecture
Status: accepted

## Summary

`shell_exec` gained an optional `background: true` input (flow 173): instead
of blocking the agent turn until the command exits (the existing
`DEFAULT_SHELL_TIMEOUT_MS`-gated synchronous path, untouched), it starts a
detached, tracked process and returns immediately with a `job_id`. Two new
`risk: "read"` tools — `shell_job_output(job_id)` (incremental, cursor-based
new-output-only) and `shell_job_kill(job_id)` — let the model check on and
stop it later. A parallel TUI layer (a sidebar "Background Jobs N" panel,
clickable rows opening a live-updating Output/Meta modal) gives the human
the same visibility without relying on the model to keep reporting back.

This is keryx's answer to the "run a dev server / tail a log and keep
working" capability other agentic CLIs expose (Claude Code's
`run_in_background`/`BashOutput`/`KillShell` is the closest analog) — see
"Prior art" below for what was deliberately or explicitly not copied.

## Details

### Harness layer: `JobRegistry`

`src/harness/tool/builtin/background-job-registry.ts` owns a session-scoped
map of tracked jobs (`start`/`get`/`list`/`readOutput`/`kill`/`sweepAll`).
Session-scoped means ONE instance is created outside `makeAgentDeps`/
`buildInteractiveAgentTools`'s per-turn tool-list rebuild and threaded
through every call for that session (`src/commands/shell.ts`, both the
readline agent branch and the TUI `makeAgentDeps` closure) — mirrors the
existing `getSessionDir`/`slateSessionBox` pattern. `buildInteractiveAgentTools`
(`src/commands/interactive-agent-tools.ts`) does **not** mint a fallback
registry when the caller omits one: `shell_job_output`/`shell_job_kill` are
simply absent from that session's tool list in that case (capability-absent
is safer than capability-present-but-orphaned).

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
— `"killed"` if the flag is set, `"exited"` otherwise — regardless of
whether the process died from SIGTERM or needed SIGKILL. Exactly one `exit`
event fires per job.

### Model-facing tools

`shell_job_output`/`shell_job_kill` are both `risk: "read"` — no approval
prompt. The safety argument: they can only ever target a `job_id` already
present in the **calling session's own** registry, so neither can do
anything beyond what the already-approved `shell_exec(background: true)`
call itself authorized; there is no path to an arbitrary OS PID. This was
adversarially reviewed and holds — with one exception that needed a
separate fix, not a `risk` change (see "Side-worker exception" below).

`shell_job_output` is exempted from the per-turn tool-call hash-attempt cap
(`REPEATABLE_TOOL_NAMES` in `src/commands/agent.ts`'s `reserveToolAttempt`)
— its whole purpose is being polled repeatedly with an identical input
(`{job_id}`), which would otherwise hash-collide with itself and hit the
loop-safety cap after 3 calls. `shell_job_kill` is deliberately **not**
exempted — repeated kill attempts are a different risk profile than
repeated reads and stay capped like any other tool.

**Side-worker exception.** A read-only side worker (spawned via
`spawn_subagent` or the TUI's own side-worker rebuild) gets its tool list
filtered to `risk === "read"` tools — which would hand it `shell_job_kill`
too, letting a lesser-trusted context kill jobs it never approved starting,
by reference to the main session's live registry. `SIDE_WORKER_DENIED_TOOL_NAMES`
(`src/tui/tui-shell.ts`) explicitly excludes `shell_job_kill` by name from
that filter, alongside the `risk === "read"` check — `shell_job_kill`'s
risk classification itself stays `"read"` (required for the tool-call
budget split below) because the fix is "stop trusting `risk` alone as a
safety boundary for this one existing consumer," not "reclassify the tool."

**Tool-call budget.** `shell_job_output`/`shell_job_kill` are `risk: "read"`
for the *other* existing purpose `risk` already served before this flow:
`src/commands/agent.ts`'s split between a small non-read tool-call pool
(`shell_exec`, `spawn_subagent`, …) and a much larger read-tool pool.
Polling a background job's output draws from the large pool, not the scarce
one.

**Approval.** `shell_exec(background: true)` goes through the *exact same*
`resolveApprovalDecision` gate as an ordinary `shell_exec` call, in all
three permission modes (`ask`/`trust`/`auto`), including the destructive/
credentials hard floor — there is no separate, stricter gate for
backgrounding. See [Permission Modes](permission-modes.md).

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

- **Poll, not push.** Codex's `wake_on_output` (re-entering the model's
  context on new output instead of the model polling) is an open,
  unshipped proposal everywhere it was found — not a buildable-now option.
  `shell_job_output` is poll-on-demand, like Claude Code's `BashOutput`.
- **No recurring per-turn reminder.** Claude Code's most-reported bug
  against this exact feature (issues #11190/#11716/#13249) is a harness-
  injected "job still running" reminder that keeps firing even after the
  job finishes or is killed — a lifecycle-tracking bug, not a design flaw
  in the reminder *concept*. keryx does not inject a recurring reminder at
  all: the model is told once, at start, and the sidebar gives the human
  independent visibility, so the burden of noticing a long-forgotten job
  doesn't rest solely on the model remembering to poll.
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
- **Push/event-driven model wakeup on new output** — not shipped anywhere
  surveyed; would need a new channel back into a live model turn.
- **A visual sidebar/inspector for the readline REPL** (`keryx shell`
  without the TUI). Readline gets the harness/tool layer in full (jobs
  work, are pollable/killable) but no visual panel — there is no sidebar
  surface to mount one in.
- **Changes to the synchronous `shell_exec` path's own behavior** —
  `DEFAULT_SHELL_TIMEOUT_MS`, its own approval flow, its own tests are
  untouched; the background path is an additive sibling that reuses the
  sandbox/env setup, not a rewrite.

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
