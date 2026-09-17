# Keryx Task Monitoring — Brainstorm and Decisions
Version: 1.0.0

## Prior art

**Inherited, not re-verified.** The competitor survey below is taken from
`docs/requirements/keryx-background-task-execution/brainstorm.md:13-20`, which
records forks read at `~/sandbox/forks/<name>/` on 2026-09-14. Those trees are
outside this repository and **this package did not re-read them**. They are
cited as the parent package's evidence, at the parent package's line numbers,
and no claim here rests on them alone.

| Tool | What it ships for this problem | Recorded at |
|---|---|---|
| **Qwen Code** | A separate `monitor` tool with `idle_timeout_ms` | parent brainstorm.md:16 |
| **Grok Build** | A separate `monitor` tool plus `/loop`/scheduler | parent brainstorm.md:14 |
| **Codex** | No monitor: a yielding PTY session continued via `write_stdin` | parent brainstorm.md:13 |
| **Gemini CLI / Crush / Cline / Continue / OpenCode** | No monitor and no scheduler in what was surveyed | parent brainstorm.md:15-20 |

The reading that matters: a `monitor` tool is **not** universal prior art. Two of
eight surveyed tools ship one, and both ship it alongside an execution model
weaker than the one keryx now has — neither had exactly-once completion delivery
when surveyed. Copying a feature from a tool that needed it for a reason keryx
has since removed is the trap this package exists to avoid.

**In-repo prior art**, verified here: the only self-rescheduling timer in the
harness is `startSupervisionTicker` (`src/harness/external/supervise.ts:601-621`),
which reschedules from inside its own callback rather than using `setInterval`
so a slow tick cannot queue up, with a tick floor of 5 ms (`:589`) and a divisor
of 4 (`:582`). It is bounded to one supervised external run and cancellable. It
is the closest thing keryx has to a scheduler, and it is deliberately not one.
Every other `setInterval` in `src/commands`, `src/tui` and `src/harness` is a
spinner or a busy-clock (`src/commands/shell.ts:788`, `:949`;
`src/tui/shell-chrome.ts:934`).

## Decisions

### D-01 — The recurring scheduler / `/loop` is closed, not deferred

**Reject** building a scheduler, and recommend removing it from the roadmap.

The grounds are in [prd.md](prd.md) §Recommendation 1; the decisive one is
arithmetic rather than taste. `DEFAULT_MAX_AUTO_WAKE = 5`
(`src/commands/agent.ts:487`) caps consecutive turns started without operator
input, and its doc comment states the hazard in as many words: "a task can start
a task, so without a bound an unattended machine can keep itself busy
indefinitely" (`:481-485`). A scheduled firing is an operator-less turn. Either
the scheduler honours the cap — and stops after five firings, which is not a
scheduler — or it is exempted, and the rail is gone.

Two supporting grounds:

- **The execution half needs no feature.** A recurring check is one supervised
  task running a shell loop. The kill rail is silence, not duration, and the
  per-call `idle_timeout_ms` reaches `MAX_TASK_IDLE_TIMEOUT_MS = 1_800_000`
  (`src/harness/tool/builtin/background-job-registry.ts:327`), so a cycle of up
  to 30 minutes survives today with zero new code.
- **Lifetime.** Tasks die with their session — "a hard, non-negotiable design
  line" (`.metaproject/wiki/architecture/background-jobs.md:261-264`, the parent
  package's D-04). A session-scoped scheduler adds nothing over the shell loop;
  a surviving one needs persistence and orphan reaping keryx has refused to own.

- Rejected: a **session-scoped scheduler** — dies with the session, so it is a
  worse-documented `while` loop.
- Rejected: a **persistent scheduler** (cron-like, surviving exit) — reverses
  the parent D-04 for a capability no observed defect asked for.
- Rejected: a **`/loop` slash command** — this is an operator-level convenience
  that belongs to whatever harness drives keryx, not inside the agent loop; the
  command list (`src/commands/agent-commands.ts:62-290`) should not grow a
  timer.
- Rejected: **exempting scheduled turns from the auto-wake cap** — that is
  deleting the only rail against unattended token burn, which the parent package
  built deliberately.

### D-02 — Push on new output / a streaming `monitor` is closed, not deferred

**Reject** streaming a task's output into a live turn.

The human already has it, live and free, in the TUI Output tab
(`src/tui/background-job-inspector.ts:224-227`) fed by the registry's `output`
event (`src/tui/background-job-session.ts:146-157`), guarded so a chatty task
does not repaint the sidebar per chunk (`src/tui/tui-shell.ts:2674`). The model
does not want the stream; it wants an answer about the stream, which is D-03.

Note the substrate already exists and is deliberately not wired to the agent:
`BackgroundJobEvent` has an `{ type: "output"; jobId; chunk; stream }` variant
(union at `background-job-registry.ts:188`) delivered only through `onEvent`
(`:532`) to the TUI bridge. Building this feature is therefore *easy*, which is
precisely why the decision has to be recorded rather than left to whoever
notices the hook.

- Rejected: **raw streaming into the turn** — a 2 MiB ring
  (`background-job-registry.ts:138`) of progress bars is how a context window
  dies.
- Rejected: **streaming with a line cap or rate limit** — a cap on a stream
  still delivers N chunks per task per turn, and it re-creates the recurring
  per-turn injection that the parent package's D-06 rejected after Claude Code's
  most-reported bug against its own background feature turned out to be exactly
  that shape (`background-jobs.md:325-332`).
- Rejected: **periodic summaries of running tasks** — a summary nobody asked for
  is the "still running" reminder under a new name; the parent design emits
  nothing at all for a running task and that should hold.

### D-03 — The surviving need is a predicate wait, not a monitor

**Specified, and PARKED by the owner (2026-09-16)** — an optional output
condition on the existing `shell_task_wait`, not to be built until the polling
cost it removes has been felt or measured. The specification stands; only the
scheduling of the work is withheld. See README §Owner's decision. The reasoning
below is what the decision was taken against, and the "doing nothing" option
rejected here is the one the owner chose to keep open a while longer — which is
exactly why it was written down rather than argued away.

The hole is real and named by the code, though it is narrower than "no wait at
all": the only wait primitive is `waitForExit(jobId, ms)`
(`background-job-registry.ts:273`), which races the task's exit against a timer
and returns `"timeout"` without killing anything (`:894-903`). So a call on a
never-exiting task is not refused — it burns the whole budget and comes back
with statuses. What does NOT exist is a wait on a CONDITION. For the headline
workload — "run a dev server / tail a log and keep working"
(`background-jobs.md:62-66`) — every wait is therefore a timeout by
construction, and the only way to learn that the server is up is to poll. The alternative available
today, polling `shell_task_output`, is legal and correct (it is in
`REPEATABLE_TOOL_NAMES`, `src/commands/agent.ts:462`) but costs a model round
per poll.

- Rejected: a **separate `monitor` tool** (the Qwen/Grok shape) — a fourth task
  tool whose job overlaps `shell_task_wait` almost entirely; the difference is
  one predicate, so it belongs as a field, not a tool.
- Rejected: **doing nothing and letting the model poll** — a defensible outcome,
  and [prd.md](prd.md) says so explicitly; it is rejected here only because the
  round cost is paid on exactly the workload the feature was built for. This is
  the decision most worth a second opinion (see §Open questions).

### D-04 — No new wake channel: the predicate wait resolves its own tool call

**Decide** that the predicate wait is a blocking tool call, never a
subscription, and that nothing about it can start a turn.

This is what keeps it cheap and what keeps the existing delivery rails provably
untouched: it cannot consume an auto-wake (`KERYX_SHELL_MAX_AUTO_WAKE`,
`src/commands/agent.ts:479`, default 5 at `:487`), it cannot fire in an idle
session because in an idle session nobody called it, and it does not touch the
`hold` wait, which is a separate mechanism built on the registry's
`onCompletion` (`src/commands/agent.ts:1617`, bounded by
`KERYX_SHELL_HOLD_MS`, `:467`/`:476`).

- Rejected: **a match delivers a notification like a completion does** — that
  would put a second producer on the exactly-once channel
  (`drainUndelivered`, drained at `agent.ts:1273`, `:1599`, `:1653`) whose whole
  correctness argument is that it has one.
- Rejected: **a match wakes an idle session** — that is a scheduler with extra
  steps, and D-01 applies.

### D-05 — The context bound is a constant, not a setting

**Decide** the four bounds — 200-byte condition, 10 matched lines, 400 bytes per
line, 4 000 bytes total — as module constants with no env override. The total
mirrors `NOTIFICATION_OUTPUT_TAIL_BYTES = 4_000` (`src/commands/agent.ts:516`)
so the two ways command output enters a turn are bounded at the same order.

The condition is a **literal substring, not a regex**. A regex over
attacker-influenced command output is a backtracking hazard with no upside for
the question being asked ("did the line appear?").

- Rejected: **env-overridable bounds** — the bound *is* the safety argument;
  an operator who can raise it will, and then the failure is silent and remote.
- Rejected: **regex conditions** — ReDoS surface on command output; a literal
  answers the real question.
- Rejected: **returning surrounding context lines** — "just 20 lines either
  side" is the first step back toward D-02.

### D-06 — Session scoping is unchanged; a wait owns no lifetime

**Keep** the parent D-04 line exactly. A predicate waiter is state inside a
running tool call, released when the call returns, the turn aborts, or the
session sweeps (`src/commands/shell.ts:1447`). It adds no persistence, no
detachment and no new cleanup path.

The question "does a scheduler outlive a session?" is not answered here because
D-01 removes the scheduler. Had it survived, this is where it would have
collided with the hard line.

### D-07 — Polling is not deprecated

`shell_task_output` stays exactly as it is, with its explicit cursor
(`background-job-registry.ts:256-266`) and its repeat exemption
(`src/commands/agent.ts:462`). The predicate wait answers a yes/no question;
reading output is a different need, and a model that wants the last 50 lines
should still read them.

- Rejected: **routing reads through the new wait** — one tool, two jobs.

### D-08 — The new wait inherits the side-worker denial, by doing nothing

`shell_task_wait` is already in `SIDE_WORKER_DENIED_TOOL_NAMES`
(`src/tui/tui-shell.ts:264`, filtered at `:4367`), so a side worker cannot call
it and therefore cannot call it with a condition either. No change is needed and
none should be made — in particular, `shell_task_output` must **not** gain a
condition field, because that tool *is* offered to side workers (`:260-263`) and
a predicate there would be a new way for a lesser-trusted context to block on
the main session's work.

- Rejected: **putting the predicate on `shell_task_output` instead** — it is the
  read a side worker is allowed to make; adding a blocking predicate to it
  re-opens the hazard D-16 of the parent package closed.

### D-09 — The wiki's out-of-scope list is corrected, not left pending

`.metaproject/wiki/architecture/background-jobs.md:345` lists "Push on new
OUTPUT (a streaming monitor tool) — still out of scope". If D-01 and D-02 are
accepted, that line should say the decision was taken and closed, with a pointer
here — an item that reads as "not yet" invites someone to build it later on the
`onEvent` hook that is already sitting there (D-02).

This package writes no wiki change itself; the correction is named as
documentation work in [prd.md](prd.md) S4.

## Alternatives considered and rejected

| Alternative | Why rejected |
|---|---|
| Build all of D-08 as written | Two of its three implied capabilities were made unnecessary by P0–P2; building them now would be inheriting a scope rather than deciding one. |
| A `monitor` tool mirroring Qwen/Grok | Two of eight surveyed tools ship one, both without exactly-once completion delivery. The overlap with `shell_task_wait` is everything but the predicate. |
| Streaming with a filter applied at the stream | Still N injections per turn; the filter belongs at the *wait*, where it produces one result, not at the stream. |
| A scheduler honouring the auto-wake cap | Stops after five firings; not a scheduler. |
| A scheduler exempt from the auto-wake cap | Deletes the only rail against unattended token burn. |
| Doing nothing at all (close all of D-08) | A legitimate outcome, and the recommended one if the owner judges the polling round-cost acceptable. Kept on the table deliberately rather than argued away. |

## Open questions — for the package owner only

These change the plan and cannot be settled from the code:

1. **Is the polling round-cost real enough to build D-03?** Nothing instruments
   `shell_task_output` calls per turn today, so the case is plausible, not
   measured. If the answer is no, close all of D-08 and delete
   [specification.md](specification.md), keeping D-01 and D-02.
2. **Are D-01 and D-02 accepted as closures rather than deferrals?** This is a
   roadmap decision, not an engineering one.
3. **Is the 4 000-byte total the right bound**, given it matches the completion
   notification tail? A reviewer may argue a wait's answer should be smaller
   than a completion's report, since it is a yes/no.
4. **Should the wiki correction (D-09) happen even if D-03 is not built?** This
   package's position is yes, but it writes no wiki change itself.
