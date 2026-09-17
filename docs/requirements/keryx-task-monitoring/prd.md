# Keryx Task Monitoring — PRD
Version: 1.0.0

## Problem

`docs/requirements/keryx-background-task-execution/brainstorm.md:81-85` (D-08)
deferred two capabilities as follow-on packages: a streaming `monitor` tool and
a recurring scheduler / `/loop`. Both were scoped when keryx had no completion
delivery at all. P0–P2 then shipped, and the ground moved.

This PRD's first obligation is therefore not to specify those two things. It is
to ask whether they are still needed, and to say plainly where they are not. A
requirements package that invents a need is worse than none.

### What P0–P2 removed from the demand

| Once needed a monitor for | Now shipped |
|---|---|
| "Tell me when the build finishes" | One `<task-notification>` per task at a round boundary, exactly once (`src/commands/agent.ts:531`, drained at `:1273`, `:1599`, `:1653`) |
| "Block until these finish" | `shell_task_wait` over `any`/`all`, clamped to `MAX_TASK_WAIT_MS = 300_000` (`src/harness/tool/builtin/background-job-registry.ts:1129`, `:1194`) |
| "Let me re-read output without losing my place" | `shell_task_output` from an explicit cursor (`background-job-registry.ts:256`, `:1050`), exempt from the repeat cap (`src/commands/agent.ts:456-464`) |
| "Let me watch it scroll" (human) | The TUI Output tab, fed by the registry's `output` event and repainted live (`src/tui/background-job-session.ts:146-157`, `src/tui/background-job-inspector.ts:224-227`) |

### The one hole that survives

`shell_task_wait` ends on **exit**: the registry primitive under it is
`waitForExit(jobId, ms)` (`background-job-registry.ts:273`). A task that never
exits therefore has no wait at all.

That is not a corner case. It is the headline workload the feature exists for —
`.metaproject/wiki/architecture/background-jobs.md:62-66` describes the
capability as "run a dev server / tail a log and keep working". For those tasks
the model's only options today are:

1. `shell_task_wait` — returns at the clamp with the task still `running`,
   having learned nothing. It never kills, so this is safe but useless.
2. `shell_task_output` in a loop — legal (it is in `REPEATABLE_TOOL_NAMES`,
   `src/commands/agent.ts:462`) and correct, but every poll is a model round,
   and the round budget is the scarce resource.

So the honest residual need is narrow and specific: **end a wait on a condition
in a running task's output.** Not a stream, and not a schedule.

## Goal

1. Answer D-08 rather than inherit it: recommend closing the scheduler clause
   and the streaming clause, with reasons a reviewer can check.
2. Specify the surviving capability — a predicate wait — so that it cannot
   flood a turn, cannot start a turn, and adds no new lifetime.

## Users

| User | Need |
|---|---|
| **Agent (the model choosing tools)** | Stop paying a round per poll to find out whether the server came up; ask once and be released when the line appears. |
| **Interactive operator** | Nothing new. The live view already exists in the TUI, and no new message type appears in the transcript. |
| **Maintainer** | Two backlog items closed with a stated reason, and one small extension to a tool that already exists, rather than a third observation mechanism. |
| **Security reviewer** | Proof that no new authority, no new lifetime, no new wake path and no new untrusted-content channel is introduced. |

## The scope call

### Recommendation 1 — drop the recurring scheduler (D-01)

**Recommend deleting this from the roadmap, not deferring it again.** Four
grounds, in order of weight:

**The execution half already works with shipped primitives.** A recurring check
is one supervised task running a loop. It is not killed for taking long — the
rail is silence, not duration
(`background-jobs.md:26`) — and a loop that prints each cycle is never silent.
Where the cadence is longer than the default idle window, `shell_exec` already
accepts a per-call `idle_timeout_ms` up to `MAX_TASK_IDLE_TIMEOUT_MS =
1_800_000` (`background-job-registry.ts:327`), i.e. a 30-minute cycle. So
"run something every N minutes" needs no new keryx feature at all.

**The notification half is Recommendation 3, not a scheduler.** What a recurring
check is actually *for* is being told when a cycle produces something
interesting. That is the predicate wait. Building a scheduler to get it would be
solving the easy half in order to reach the hard half sideways.

**A scheduler is a machine for defeating the auto-wake cap.**
`DEFAULT_MAX_AUTO_WAKE = 5` exists precisely because "a task can start a task,
so without a bound an unattended machine can keep itself busy indefinitely"
(`src/commands/agent.ts:481-487`). Every scheduled firing is an operator-less
turn. Honour the cap and the scheduler stops after five firings, which is not a
scheduler; exempt it and the rail that this project deliberately built is gone.
There is no third option, and this package will not propose one.

**It contradicts D-04's session-scoping line, or it is pointless.** Tasks die
with their session and this is called "a hard, non-negotiable design line"
(`background-jobs.md:261-264`). A scheduler that also dies with the session buys
nothing over the shell loop above; one that survives needs persistence, orphan
reaping and a lifetime keryx has refused to own.

### Recommendation 2 — drop push-on-new-output / the streaming `monitor` (D-02)

**Recommend deleting this too.** Streaming a chatty command's output into a live
turn is the context-window failure mode, and the two parties who would consume
the stream are already served:

- The **human** has it, live, for free, in the TUI Output tab
  (`src/tui/background-job-inspector.ts:224-227`), repainted on the registry's
  `output` event (`src/tui/background-job-session.ts:146-157`) under a guard
  that stops a chatty task repainting the sidebar per chunk
  (`src/tui/tui-shell.ts:2674`). Tokens: zero.
- The **model** does not want a stream. It wants the answer to a question about
  the stream ("is it listening yet?", "did it error?"). A stream makes the model
  read `MAX_BACKGROUND_OUTPUT_BYTES = 2 * 1024 * 1024`
  (`background-job-registry.ts:138`) of webpack progress bars to find one line.

There is a further reason specific to this project: a recurring injection into
the turn is the shape D-06 of the parent package already rejected, after Claude
Code's most-reported bug against its own background feature turned out to be
exactly that (`background-jobs.md:325-332`). Push-on-output is that shape with a
higher frequency.

### Recommendation 3 — build the predicate wait (D-03)

Extend `shell_task_wait` with an optional output condition. It is the only part
of D-08 that survives, it is small, and it is an extension of a tool that
already exists rather than a fourth task tool.

## Requirements

### Functional

| # | Requirement |
|---|---|
| F1 | `shell_task_wait` accepts an optional output condition; the wait ends on the first of: the `any`/`all` exit condition, a condition match, the clamped timeout, or the turn's abort. |
| F2 | A wait that ends on a match returns **only the matched lines**, capped in count and bytes, plus each task's status and next cursor — never the surrounding output. |
| F3 | A condition already satisfied by retained output returns immediately rather than blocking until the timeout. |
| F4 | The result names why the wait ended (`exit` / `match` / `timeout` / `interrupted`), so the model never has to infer it. |
| F5 | A predicate wait never kills, never promotes and never demotes a task, exactly as the exit wait does not. |
| F6 | A wait on a still-running task does not mark it observed, so its completion notification is still delivered later. |
| F7 | No new tool, no new slash command, no new env var and no new wake path is introduced. |

### Non-functional

| # | Requirement |
|---|---|
| N1 | Matching is incremental: each newly appended chunk is scanned once. A wait is never implemented by re-scanning the whole ring per output event. |
| N2 | The condition is a literal substring, not a regex — no catastrophic-backtracking surface on attacker-influenced command output (D-05). |
| N3 | Zero new npm dependencies. |
| N4 | The existing clamp `MAX_TASK_WAIT_MS = 300_000` (`background-job-registry.ts:1129`) bounds the predicate wait unchanged; no longer bound is introduced. |
| N5 | Bytes returned by one predicate wait are bounded by a constant of the same order as the notification tail, `NOTIFICATION_OUTPUT_TAIL_BYTES = 4_000` (`src/commands/agent.ts:516`). |

## Success criteria

| # | Criterion | Status |
|---|---|---|
| S1 | A model can learn that a never-exiting task reached a known state without spending a round per poll. | planned |
| S2 | One predicate wait cannot put more than the specified cap of command output into a turn, whatever the command prints. | planned |
| S3 | The auto-wake cap, the hold, and exactly-once completion delivery are provably unchanged. | planned |
| S4 | D-08's scheduler and streaming clauses are closed with a recorded reason, and the wiki's out-of-scope list is corrected to match. | planned (documentation) |
| S5 | No implementation claim in this package is unsupported by a `file:line`. | documentation check, not a runtime claim |

## Risks

| # | Risk | Mitigation | Residual |
|---|---|---|---|
| R1 | A stale match: the condition is found in output the model already read, so the wait returns instantly with old news. | The caller may pass the cursor `shell_task_output` already returns (`background-job-registry.ts:256-266`) to scan only from there. | With no cursor, the default scans retained output; returning immediately is the safer failure than hanging to the clamp. |
| R2 | The condition never appears (typo, changed log format), so every wait runs to the clamp. | The clamp is the existing 300 s bound and the wait never kills; the result says `timeout` and carries each task's status. | Up to 300 s of wall time per mistaken wait. A model that mistypes twice costs two rounds, not a stuck session. |
| R3 | A chatty task makes matching hot on the output path, which is also the TUI repaint path. | Scan each appended chunk once (N1); the condition is a literal substring (N2). | Unmeasured until built; named in metrics as M6. |
| R4 | Matched command output enters the turn, and a command can print anything, including something shaped like an instruction. | It enters as a **tool result**, which is where `shell_task_output` already puts raw command output today — the same channel at the same trust, not a new one. No `user`-role message and no banner are involved, and `untrustedContentSeen` (`src/commands/agent.ts:1403`) is untouched. | Unchanged from today's read tool. |
| R5 | The predicate wait becomes a de-facto poll loop the model spins on. | `shell_task_wait` is already in `REPEATABLE_TOOL_NAMES` (`src/commands/agent.ts:463`), so this is not a new exposure; the round budget still applies. | A model can still burn rounds waiting badly, as it can today. |
| R6 | Scope creep back toward a monitor: "since we are matching, stream the rest too". | The cap in F2 is a criterion with a named proof (M2), not a guideline. | Reviewer vigilance. |

## Recommendation

Adopt Recommendations 1 and 2 as **closures**: remove the scheduler and the
streaming monitor from the roadmap, and correct
`.metaproject/wiki/architecture/background-jobs.md:345` so its out-of-scope list
records them as decided rather than pending.

Adopt Recommendation 3 only if the round cost of polling is judged real. It is
the only item here with a build cost, and it is deliberately specified as the
smallest thing that closes the hole: one optional input field on one existing
tool.

If the package owner disagrees with Recommendation 3, the correct outcome is to
close all of D-08 and delete this package's specification, keeping the
recommendations. That is a legitimate result and no part of this package argues
otherwise.

## Gaps

| Gap | Impact | Tracked |
|---|---|---|
| Whether polling actually costs enough rounds to justify F1 is **unmeasured**. No instrumentation counts `shell_task_output` calls per turn today. | The entire case for Recommendation 3 rests on a plausible cost, not a measured one. | metrics M1; the human decision listed in brainstorm.md §Open questions. |
| The competitor prior art for `monitor` (Qwen, Grok) is **inherited, not re-verified** by this package. | The forks were read on 2026-09-14 for the parent package and are outside this repository; nothing here re-read them. | brainstorm.md §Prior art, which marks them as inherited. |
| R3's cost on the output hot path is unknown until built. | A regression here would show up as TUI repaint lag on a chatty task. | metrics M6. |
| This package does not touch on-disk output. | Output beyond the 2 MiB ring is still gone, so a condition that appeared and was evicted cannot be matched retrospectively. | The parent package's D-18; unchanged. |
