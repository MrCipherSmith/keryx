# Keryx Task Monitoring — Requirements Package
Version: 1.0.0

## Status

**Nothing here is implemented.** Every runtime claim in this package is marked
`planned` unless a `file:line` proves it exists today.

This package exists to answer a question that was deferred, not to build what
was deferred. `docs/requirements/keryx-background-task-execution/` names two
follow-ons in decision D-08 — "a streaming `monitor` tool and a recurring
scheduler / `/loop`" — and
[`.metaproject/wiki/architecture/background-jobs.md:345`](../../../.metaproject/wiki/architecture/background-jobs.md)
still lists "Push on new OUTPUT (a streaming monitor tool)" as out of scope.
Phases P0–P2 of that package then shipped and solved the adjacent problem, so
the first job of this package is to re-ask whether either follow-on is still
worth building.

**The answer is mostly no.** Of the two candidates D-08 named:

- The **recurring scheduler / `/loop` is recommended for deletion**, not
  deferral. Its execution half is already expressible with shipped primitives
  (D-01), and its notification half is the one thing that is genuinely missing —
  which is the third thing below, not a scheduler.
- **Push on new output (a streaming `monitor`) is recommended for deletion.**
  Streaming a chatty command into a live turn is the context-window failure
  mode, and the human already has the live view in the TUI
  (`src/tui/background-job-inspector.ts:224`), where it costs no tokens at all
  (D-02).
- One **real, small gap survives scrutiny**: there is no wait on a CONDITION.
  `shell_task_wait` can only wait for EXIT
  (`src/harness/tool/builtin/background-job-registry.ts:273`, which races the
  exit against a timer and returns `"timeout"` without killing, `:894-903`), so
  for a dev server or a `tail -f` — the exact workload backgrounding exists for
  ([background-jobs.md:62-66](../../../.metaproject/wiki/architecture/background-jobs.md)) —
  a wait is a timeout by construction and the model's only way to learn the
  server is up is to poll. This package specifies a
  **predicate wait** to close that, as an extension of the existing tool rather
  than a new `monitor` (D-03).

So this package is one modest change plus two recommendations to stop tracking
work. If only the recommendations are accepted and the predicate wait is not
built, that is a coherent outcome and the package says so rather than
manufacturing a reason to ship something.

## Owner's decision (2026-09-16)

**Both closures accepted. The predicate wait is PARKED, not scheduled.**

D-01 (the recurring scheduler / `/loop`) and D-02 (push on new output) are closed
— removed from the roadmap, not deferred to a later phase. The grounds recorded
below are accepted as they stand.

D-03's predicate wait is neither built nor deleted. The reason is the package's
own open question #1: nothing measures how often `shell_task_output` is actually
polled, so the case for it is plausible and unmeasured. Phase P0 of the parent
package was built from a live incident — a `sleep 120` that froze a real turn —
and that is why it landed well. There is no equivalent incident here. The
specification stays on disk, ready, and is picked up when someone actually pays
the polling cost on a running task and says so.

What would change the decision: a session where the round cost is felt, or a
measurement of polls per turn. Either turns "plausible" into "measured", which is
the bar this package set for itself.

## Purpose

Decide what remains of D-08 after P0–P2, and specify only the part that
survives: letting the agent wait for a **condition in a running task's output**
instead of polling for it, under a bound that cannot flood a turn.

## What already shipped (why most of D-08 is gone)

The follow-ons were scoped when "I want to know when it finishes" was unsolved.
It is now solved, which removes most of the demand D-08 was carrying:

| Capability | Where it lives now |
|---|---|
| A task reports its own completion exactly once | `drainUndelivered` (`background-job-registry.ts:292`) and `onCompletion` (`:299`); the notification is built in `src/commands/agent.ts:531` and pushed at `:1273`, `:1599`, `:1653` |
| Waiting for `any`/`all` of a set to finish, under a clamped bound | `shell_task_wait`, clamp `MAX_TASK_WAIT_MS = 300_000` (`background-job-registry.ts:1129`, `:1140`, `:1194`) |
| Reading output from an explicit cursor, repeatably | `shell_task_output` (`background-job-registry.ts:1050`), exempt from the per-signature attempt cap (`src/commands/agent.ts:456-464`) |
| An interrupt that releases a wait without killing the task | `src/harness/tool/builtin/interactive-tools.ts:35` |
| A live human-facing output view | `src/tui/background-job-session.ts:146-157`, `src/tui/background-job-inspector.ts:224-227` |

## Document index

| Document | Audience | Read it when |
|---|---|---|
| [prd.md](prd.md) | anyone | You want the honest scope call — which half of D-08 dies, which survives, and why. |
| [specification.md](specification.md) | implementer | You need the exact tool change, its bounds, config, integration points and acceptance criteria. |
| [brainstorm.md](brainstorm.md) | reviewer | You want the recorded decisions D-01…D-09 with the rejected alternative for each. |
| [metrics-and-validation.md](metrics-and-validation.md) | anyone | You want the measurable invariants and the named proof each one needs. |

Related, outside this package:

- [`docs/requirements/keryx-background-task-execution/`](../keryx-background-task-execution/README.md) —
  the package this one follows on from; its D-08 is what is being re-decided.
- [`.metaproject/wiki/architecture/background-jobs.md`](../../../.metaproject/wiki/architecture/background-jobs.md) —
  the accepted description of the shipped supervised-task model.

## Scope

**In scope**

- A **predicate wait**: `shell_task_wait` gains an optional output condition, so
  a wait can end on a match in a still-running task rather than only on exit.
- A **hard context bound** on what that wait returns: matched lines only, capped
  in both count and bytes.
- A recommendation, with reasons, to **close** D-08's scheduler and streaming
  clauses rather than carry them.

**Out of scope** (named, with reasons in [brainstorm.md](brainstorm.md))

- A recurring scheduler, `/loop`, cron, or any timer that starts a turn (D-01).
- Push on new output / a streaming `monitor` tool (D-02).
- A new wake channel, or any change to the hold (`KERYX_SHELL_HOLD_MS`) or the
  auto-wake cap (`KERYX_SHELL_MAX_AUTO_WAKE`) (D-04).
- Any change to task lifetime, the approval gate, or the OS sandbox (D-06).
- On-disk full output (still the background-task package's D-18).

## Related modules

| Module | Relationship |
|---|---|
| `src/harness/tool/builtin/background-job-registry.ts` | Owns `shell_task_wait` (`:1194`), `waitForExit` (`:273`), `readOutputSince` (`:256`) and the output ring; the predicate wait is added here. |
| `src/commands/agent.ts` | `REPEATABLE_TOOL_NAMES` (`:456`), the notification builder (`:531`) and the drains (`:1273`, `:1599`, `:1653`) the new wait must not disturb. |
| `src/tui/tui-shell.ts` | `SIDE_WORKER_DENIED_TOOL_NAMES` (`:249`), which already denies `shell_task_wait` to side workers. |
| `src/tui/background-job-session.ts`, `src/tui/background-job-inspector.ts` | The live output surface that already exists for the human, and the reason a streaming tool for the model is not needed. |
| `src/harness/external/supervise.ts` | `startSupervisionTicker` (`:601`) — the only self-rescheduling timer in the harness, and the precedent a scheduler would have cited. |
