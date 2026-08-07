# Keryx Shell Remediation v2 — PRD
Version: 1.0.0

## Problem

The second benchmark run put keryx and `opencode` on the **same model**
(`deepseek-v4-flash`) against the same repository, and twice the wrapped agent
gave the worse answer.

| Case | keryx | `opencode`, same model |
|---|---|---|
| A3 — import cycles | 8 cycles, 14.0 s, unqualified | the same 8, then checked the source: **5 of them run through `await import()`** and are not load-order cycles |
| A4 — orphaned files | 14 orphans, 14.0 s, unqualified | the same 14, then checked: *"only 2 are genuine orphans — the rest are reachable entry points that the graph doesn't model"* |

Two independent cases, one pattern. It has two causes and they compound:

1. **The tool is wrong** (P1). `gdgraph` treats a dynamic import as an ordinary
   edge, so its cycle count is inflated on any codebase that lazy-loads.
2. **The agent is instructed not to check** (P3). The shell's system prompt says
   *"give the shortest correct answer"*, and the model applies that to its
   tool-call budget, not just to prose — from its own reasoning in the A1
   transcript: *"The instructions say be economical, but accuracy matters."*

A confident first-party tool plus an instruction not to spend tokens verifying it
is how a wrong answer arrives with the shape of a computed fact.

Separately, two defects make keryx's protections misrepresent themselves:

3. **The approval menu offers a grant that can never apply** (P2). For a command
   containing `>` and `&&`, it offers "Always allow `echo *`" — which
   `isShellCommandAllowed` will never honour, because the metacharacter barrier
   rejects such commands before the allowlist is consulted. The code states the
   invariant this breaks three lines above the code that breaks it.
4. **A Linux install has no OS containment, and nothing says so** (P4).
   Filesystem containment and network-off *are* implemented on Linux; both need
   `bubblewrap`, which `scripts/install.sh` never mentions, never checks for and
   never warns about. There is no `doctor` command either.

## Goal

**Make keryx's answers safe to trust, and its protections honest about
themselves.**

Concretely: a keryx answer derived from a first-party tool should be right or
visibly qualified; and a user should never have to run an experiment to discover
which protections they have.

## Users

| User | What they hit today |
|---|---|
| An engineer asking a structural question | Gets a confident cycle or orphan count that is wrong on any lazy-loading codebase, with nothing signalling that it needs checking |
| An operator answering an approval prompt | Is offered a "remember this" that silently will not apply, and the grant described is not about the command on screen |
| Anyone running keryx on Linux | Believes they have OS containment; has none, and nothing tells them |
| Whoever reads the benchmark report | Cannot separate "keryx contains the agent" from "keryx would, if a package it never asked for were present" |

## Requirements

| # | Requirement | Defect |
|---|---|---|
| R1 | Cycle detection must not treat a dynamic import as a load-order edge — either exclude such edges or report them separately | P1 |
| R2 | Any count `gdgraph` reports must be reproducible from the same graph by an independent reader, with the edge kinds it counted stated | P1 |
| R3 | The approval UI must not offer a grant that the allowlist matcher would refuse for the command being approved | P2 |
| R4 | Economy in the system prompt must govern output length, not the tool-call budget | P3 |
| R5 | The system prompt must say when a first-party tool result is to be checked against source — specifically when that result *is* the deliverable | P3 |
| R6 | Brevity must be preserved: the 14.0 s answer is a real product advantage and must not be traded away wholesale | P3 |
| R7 | Installation must state, per platform, which containment capabilities are available and what is required for them | P4 |
| R8 | A user must be able to ask, at any time and without running a contained command, which containment capabilities are live | P4 |

## Success criteria

Each is a measurement, not an opinion. The first two are already available as
fixtures — run 2 recorded the wrong answers.

| # | Criterion | How it is proven |
|---|---|---|
| S1 | A3 on `helyx@bfad745b` no longer reports 8 unqualified cycles | Re-run; the answer either excludes the 5 dynamic-import cycles or marks them |
| S2 | A4 on the same target no longer reports 14 unqualified orphans | Re-run; the answer distinguishes "not imported" from "unreachable" |
| S3 | An approval prompt for a command with an unquoted metacharacter offers no "always" grant | Unit test over `suggestShellPatterns` with the C3 command as input |
| S4 | The shell answer to a tool-backed question qualifies the tool's output when that output is the deliverable | Regression fixture from A3, per flow 139's AC4 |
| S5 | Brevity holds | The A3/A4 answers stay far below the interactive legs' wall-clock; a large regression here fails the flow |
| S6 | A Linux user is told what they have | `keryx doctor` (or equivalent) reports launcher availability and the per-capability matrix without running a contained command |

## Risks

| Risk | Why it matters | Mitigation |
|---|---|---|
| **Over-correcting P3** | Telling the agent to verify everything destroys the 14 s advantage and adds cost to every answer. On the A1 re-run the leg that *did* verify **invented a correction** — a test file "missing from the graph" that does not contain the string `config` at all | R5 is scoped to "when the tool's result is the deliverable", not to all tool use. S5 guards the other side |
| **P1's fix changes historical numbers** | Every previously reported cycle count on a lazy-loading repo becomes different | State it in the changelog. The old numbers were wrong; that is the point |
| **P4 turns into feature work** | "Make the allowlist work on Linux" is a netns-plus-relay project | Explicitly out of scope (README non-goals). v2 only makes the current state visible |
| **The fixes are graded by the same benchmark that found them** | Circular validation | The fixtures are frozen from run 2 and the expected answers are recorded in `evidence/grading-key.md` before any fix lands |

## Recommendation

Do all four, in this order: **P1, then P3, then P2, then P4.**

P1 first because it is the concrete wrong answer and it gives P3 its regression
fixture — fix the disposition against a tool that is still wrong and you cannot
tell whether the agent checked or merely got lucky. P3 second, since it is the
structural one and the only one that changes every answer keryx gives. P2 and P4
are independent of both and can be done in either order, or in parallel by
someone else.
