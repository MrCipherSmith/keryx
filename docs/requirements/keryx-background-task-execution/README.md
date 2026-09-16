# Keryx Background Task Execution — Requirements Package
Version: 1.1.0

## Status

**Phase P0 is implemented** (2026-09-16, keryx flow 263): every `shell_exec`
call is a supervised task that returns within a bounded yield, a command that
outlives the yield keeps running as a background task instead of freezing the
turn, the wall-clock deadline is replaced by an idle timeout (pulled forward
from P1), terminal statuses are `completed`/`failed`/`killed` with a
`killReason`, and the TUI lists a task only once it is in the background. The
rest of the package — completion delivery and the `hold`/wake rules (P1), the
task tools, tool cancellation, operator demote and side-worker rules (P2), the
documentation sweep (P3) — is still `spec ready` and **not implemented**; see
[metrics-and-validation.md](metrics-and-validation.md) for which invariant is
proven and by which test.

v1.1.0 closed the implementation gaps found when v1.0.0 was checked against the
code (headless delivery, notification shape, wake cap, concurrency cap, idle
escape, statuses, tool cancellation, side-worker access, no-registry path,
on-disk output): see [brainstorm.md](brainstorm.md) D-09…D-18. The package
replaces the
flow-173 **opt-in model** and the synchronous blocking default, while keeping
the flow-173 background registry, process-group ownership and session-scoping.
The current behaviour is documented in
`.metaproject/wiki/architecture/background-jobs.md`. Every runtime claim below
is marked `planned` unless a `file:line` proves it exists today.

## Purpose

Make non-blocking shell execution **structural** instead of a choice the model
must remember to make.

Today `shell_exec` has two modes, and the model picks between them by setting an
optional `background: true` boolean (`src/harness/tool/builtin/shell-exec-tool.ts:238`).
Omit it — or, as observed live, narrate "I'll run this in the background" and
then omit it — and the call takes the synchronous path, which blocks the whole
agent turn on `await proc.exited` until the command exits or the wall-clock
`DEFAULT_SHELL_TIMEOUT_MS` of 120 s fires
(`src/harness/tool/builtin/shell-exec-tool.ts:46`, `:157`, `:176-182`).

This package specifies an execution model in which **every** shell command is a
supervised task: the tool call returns within a bounded yield, completion is
delivered as an event that can wake the agent, timeouts are idle-based rather
than wall-clock, and the operator can interrupt a wait or demote a running
command. The foreground/background choice disappears, so the observed failure
mode cannot recur by construction.

## Document index

| Document | Audience | Read it when |
|---|---|---|
| [prd.md](prd.md) | anyone | You want the problem, goals, users, requirements, success criteria and risks. |
| [specification.md](specification.md) | implementer | You need the exact task model, tool surface, config, data contracts, integration points and acceptance criteria. |
| [brainstorm.md](brainstorm.md) | reviewer | You want the competitor prior art and the recorded decisions (D-01…D-08 design, D-09…D-18 implementation) behind the design. |
| [metrics-and-validation.md](metrics-and-validation.md) | anyone | You want to know which invariants are measurable and how each is to be proven. |
| [schemas/shell-task.schema.json](schemas/shell-task.schema.json) | implementer | You are implementing the task handle/state record. |
| [schemas/shell-task-event.schema.json](schemas/shell-task-event.schema.json) | implementer | You are implementing the task lifecycle event stream (start/output/exit). |

Related, outside this package:

- [`.metaproject/wiki/architecture/background-jobs.md`](../../../.metaproject/wiki/architecture/background-jobs.md) —
  the accepted description of the current flow-173 background path this package
  supersedes.
- [Keryx OS Sandbox](../keryx-os-sandbox/README.md) — the containment layer the
  task supervisor must keep reusing, not reimplement.
- [Permission Modes](../../../.metaproject/wiki/architecture/permission-modes.md) —
  the approval gate the task supervisor must keep reusing unchanged.

## Scope

**In scope**

- A session-scoped shell **task supervisor** that owns each command's process
  group and bounded output buffer.
- A **bounded yield** on every `shell_exec` call: the tool returns a task handle
  within `yield_ms` whether or not the command has exited.
- **Event-driven completion**: a terminal task event is delivered to the agent
  without polling and without `sleep`.
- **Idle-based timeout**: a task is killed after `idle_ms` with no output, not
  after a fixed wall-clock.
- Operator **interrupt of a wait** and **demotion** of a running task to
  background.
- Observation/control tools: output, wait, kill.
- `background: true` retained as a compatibility alias.

**Out of scope** (named, with reasons in [brainstorm.md](brainstorm.md))

- Detaching a task so it survives session exit (keryx's hard session-scoping
  line is kept, D-04).
- A streaming `monitor` tool and a recurring scheduler / `/loop` (follow-on
  packages, D-08).
- Any change to the approval gate or the OS sandbox (reused unchanged, D-05).
- A recurring "task still running" reminder (rejected, D-06).

## Related modules

| Module | Relationship |
|---|---|
| `src/harness/tool/builtin/shell-exec-tool.ts` | The synchronous path and `background` branch this package replaces with a yield. |
| `src/harness/tool/builtin/background-job-registry.ts` | The existing `JobRegistry` and the two read tools; the supervisor generalizes this. |
| `src/commands/interactive-agent-tools.ts` | The single factory both `keryx shell` and the TUI build their tool list from. |
| `src/commands/agent.ts` | The tool loop that must deliver completion events and keep the call budget split. |
| `src/commands/shell.ts`, `src/tui/tui-shell.ts` | Session-scoped supervisor creation and the real session-exit sweep sites. |
| `src/tui/background-job-*.ts`, `src/tui/job-bridge.ts` | The existing sidebar/inspector surface the new lifecycle must keep coherent. |
