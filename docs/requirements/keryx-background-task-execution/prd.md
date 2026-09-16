# Keryx Background Task Execution — PRD
Version: 1.1.0

## Problem

`shell_exec` models a process as a request/response call. That is true only when
the command is short. For anything long it is the wrong shape, and the gap is
closed today by an **optional boolean the model must remember to set**.

### The observed defect

A live session ran, through the synchronous path:

```
shell_exec(command="sleep 120 && gh run list --workflow=release.yml …")
```

No `background: true` was set. The turn blocked on `await proc.exited`
(`src/harness/tool/builtin/shell-exec-tool.ts:157`) for the full 120 s wall-clock
deadline, then SIGTERM/SIGKILL'd the process and returned
`shell_exec: timed out after 120000ms and was killed`
(`src/harness/tool/builtin/shell-exec-tool.ts:176-182`). The model had narrated
that it would "start a background task", but the narration and the tool-call
argument are unrelated: keryx infers nothing from assistant text. A subsequent
`shell_job_kill(job-1-64982)` failed with `not running`, because the blocking
call was never registered as a job at all.

Three distinct defects are visible in that one incident:

1. **The blocking mode is the default.** Forgetting one optional field costs the
   whole turn for up to 120 s.
2. **The timeout is wall-clock, not activity-based.** A command that is still
   producing output is killed at 120 s regardless; a genuinely stuck command is
   only discovered at 120 s.
3. **There is no escape hatch.** Once the synchronous path is running, the only
   ways out are the deadline or a user interrupt; the operator cannot demote the
   command and keep working.

### Why the existing background path does not fix it

Flow 173 added a correct, bounded, process-group-owning background path
(`src/harness/tool/builtin/background-job-registry.ts`; documented in
`.metaproject/wiki/architecture/background-jobs.md`). It is **opt-in**
(`src/harness/tool/builtin/shell-exec-tool.ts:238`), it is **poll-only** — the
wiki records the deliberate decision "Poll, not push" — and it changes nothing
about the synchronous path. So it is available exactly when the model already
knows it needs it, and unavailable in the failure above, which is when it does
not.

## Goal

Make non-blocking execution a property of the execution model, not a model
decision:

1. Every `shell_exec` call returns a task handle within a bounded yield,
   regardless of whether the command has exited.
2. Completion and output are delivered as events; the agent is notified on
   completion and never needs to poll or `sleep`.
3. A running task is killed on **inactivity**, not on a fixed wall-clock.
4. The operator can interrupt a wait and demote a running task to background.
5. The existing approval gate, OS sandbox, process-group ownership and
   session-scoped lifetime are preserved unchanged.

## Users

| User | Need |
|---|---|
| **Interactive operator** | A long command must never freeze the session; be able to keep typing, interrupt a wait, and demote a command that turns out to be long. |
| **Agent (the model choosing tools)** | One unambiguous execution contract — no foreground/background branch to get wrong — and a completion signal it does not have to remember to poll for. |
| **Maintainer** | One supervisor with one lifecycle, replacing two paths whose interaction produced the defect. |
| **Security reviewer** | Proof that the new path reuses the existing approval gate, sandbox and process-group kill, and adds no new authority. |

## Requirements

### Functional

| # | Requirement |
|---|---|
| F1 | Every `shell_exec` invocation starts a supervised task and returns a handle within `yield_ms`, whether or not the command has exited. |
| F2 | The supervisor owns each task's process group, buffers output under a bounded cap, and tracks terminal status. |
| F3 | A terminal task event (completed / failed / killed) is delivered to the agent as an event that can start or continue a turn, without polling. |
| F4 | A task is killed after `idle_ms` with no output, not after a fixed wall-clock. |
| F5 | The operator can interrupt a turn waiting on a task, and can demote a running task to background. |
| F6 | Observation/control tools exist: task output (incremental), wait (one or many, with timeout), kill. |
| F7 | `shell_exec` approval goes through the existing `resolveApprovalDecision` gate unchanged, in all permission modes. |
| F8 | Tasks are session-scoped: every real session-exit path sweeps them, exactly as flow 173 does today. |
| F9 | The agent is told once, at start, that it will be notified on completion; no recurring "still running" reminder is emitted. |
| F10 | `background: true` remains accepted as a compatibility alias meaning "return the handle immediately, do not wait for the yield". |
| F11 | A session that cannot be woken (`--print`, unattended) does not end a turn while a yielded task runs; it waits, bounded, and reports the result (D-09). |
| F12 | Completion-started turns are capped when no operator input arrives between them (D-11). |
| F13 | A short command is never refused because background tasks fill the concurrency cap (D-12). |
| F14 | A side worker can neither kill, wait on, advance the cursor of, nor suppress the notification of a main-session task (D-16). |
| F15 | The model can request a longer idle timeout for an intentionally silent command, within a hard ceiling; it cannot disable the timeout (D-13). |

### Non-functional

| # | Requirement |
|---|---|
| N1 | Per-task output is bounded by a ring cap; terminated tasks are evicted by an LRU bound. No unbounded growth over a long session. |
| N2 | Zero new npm dependencies. The supervisor uses `Bun.spawn` and existing primitives. |
| N3 | Kill signals the process group (`-pid`), reaching grandchildren the command backgrounded and forgot. |
| N4 | Event delivery must not busy-wait or block the agent loop; it uses the existing turn/queue mechanism. |
| N5 | Exactly one terminal event per task, delivered at most once to the agent. |
| N6 | Sandbox and environment resolution are shared with the existing path, not reimplemented. |

## Success criteria

| # | Criterion | Status |
|---|---|---|
| S1 | The exact incident does not recur: `shell_exec("sleep 120 && …")` with no flag returns within `yield_ms` and the turn continues; the task is then observable and killable. | met (P0) |
| S2 | A command that keeps producing output past 120 s is not killed; a command silent for `idle_ms` is. | met (P0) |
| S3 | On task exit the agent is notified without a poll and without a `sleep`-based wait. | met (P1) |
| S4 | The operator can send a message while a task is awaited and it takes over immediately. | planned (P2) |
| S5 | A process-group kill reaches a grandchild backgrounded by the command. | met (P0) |
| S6 | No implementation claim in this package is unsupported by a `file:line`. | documentation check, not a runtime claim |

## Risks

| # | Risk | Mitigation | Residual |
|---|---|---|---|
| R1 | Completion delivery is a new channel into the agent loop; a bug can drop a completion or deliver it twice. | Exactly-once terminal event; delivery state recorded on the task; a completion reminder is idempotent on replay. | Needs dedicated tests; see metrics-and-validation.md. |
| R2 | Auto-yield changes semantics for callers that relied on blocking (scripts, other tools that expect the full result). | The synchronous result is preserved when the command exits within the yield; `background: true` stays accepted; the change is documented as a behaviour change. | A command that used to return at 90 s now returns a handle at `yield_ms` and a completion later. |
| R3 | Idle-timeout can kill a legitimately silent command (a genuine wait). | The kill is on inactivity with an explicit per-call escape, `idle_timeout_ms` up to 30 min, recorded in the task (D-13); the kill states its reason. | A model that wants a long silent wait must say so; a wait over 30 min needs the operator's env. |
| R4 | Session-scoped tasks do not survive a crash; a completion can be lost. | Tasks are not persisted, so nothing is ever reported as success after a crash: a handle from a resumed transcript resolves to `unknown task_id` (D-14). | A task in flight across a crash is not resumed and its result is lost. |
| R6 | A completion notification is a new way for command output to enter history as a `user`-role message. | Fixed envelope and banner, `provenance: "tool"`, bounded tail, pushed only at round boundaries (D-10). | Providers do not read `provenance` today; the banner is what the model sees. |
| R7 | Automatic wakes can loop with nobody present. | Wake cap (D-11); hold rounds count toward `maxRounds` (D-09). | Up to `maxAutoWake` unattended turns can still run. |
| R5 | The TUI sidebar/inspector assumes the flow-173 lifecycle. | The new lifecycle is specified to be a superset; the existing store/inspector contract is a named integration point and a regression surface. | UI work is part of the implementation, not this package. |

## Recommendation

Adopt the supervised-task model and keep everything else. Specifically:

- **Reuse, do not rebuild**, the approval gate (`resolveApprovalDecision`), the
  OS sandbox resolution, and the process-group ownership already proven in
  flow 173.
- **Do not** make backgrounding opt-in; that is the defect.
- **Do not** keep a wall-clock deadline as the primary timeout; use inactivity.
- **Do not** detach tasks beyond the session; keryx's session-scoping line is
  kept deliberately.
- Ship in phases (see specification §Acceptance criteria): yield+handle first,
  then completion events, then idle-timeout, then operator demote/interrupt,
  then the observation tools and TUI coherence.

## Gaps

| Gap | Impact | Tracked |
|---|---|---|
| P2 and P3 are not implemented: the task tools, tool cancellation, operator demote and the side-worker rules, and the documentation sweep. | The operator cannot yet demote or interrupt a running task, and a tool call cannot be cancelled. | This package, specification §Acceptance criteria. P0 shipped in flow 263, P1 in flow 265. |
| Closed in P1: the completion-wake channel now exists — `drainUndelivered`/`onCompletion` on the registry, a round-boundary drain and a hold in `src/commands/agent.ts`, and a subscription in both REPLs. | It was the largest new mechanism in this package; it is now the one with the most test weight behind it. | brainstorm.md D-02; metrics M5, M6, M11, M16. |
| Streaming `monitor` and recurring scheduling are not specified here. | Long-lived event streams and periodic checks stay manual. | brainstorm.md D-08; follow-on packages. |
| No on-disk full output. | Output beyond the 2 MiB ring (or the 4 KB post-delivery tail) is gone. | brainstorm.md D-18; follow-on package. |
| Consecutive `user`-role messages remain unverified against a live strict adapter. | A notification followed by an operator message may be rejected by a provider that requires strict alternation. | brainstorm.md D-10. Checked in P1: no adapter in `src/harness/provider/` merges, splits or rejects consecutive `user` turns, so nothing in keryx normalizes this away; the P1 suites exercise the shape with a scripted provider only. |
