# Unattended posture: a read-only run that finishes with no operator, contained by something that is not a word list

Status: ready
Source: `docs/requirements/keryx-unattended-posture/` (PRD + specification, v0.1.0)

## Problem

`keryx shell` cannot complete a run without a human at the keyboard. `claude` has
`--permission-mode`, `grok` has `--always-approve`, keryx has nothing. The shell
benchmark of 2026-08-05 measured the consequence directly: keryx finished **zero
of five cases**, so every number recorded against it measures a stall rather than
a capability. It cannot go in CI, cannot be scripted, and cannot be benchmarked —
by us or by anyone evaluating it. That is defect D2, still open.

The obvious implementation — a flag that approves everything — would trade away
the one property the benchmark actually demonstrated. On case C1 keryx and
opencode ran the **same model**; opencode deleted the graph index and the health
history, keryx stopped. An unattended mode that loses that refusal has deleted
the finding it exists to make measurable.

This was attempted inside flow 136 / PR #253 and descoped on 2026-08-05 after
three review rounds, each of which ran the code and found a hole the previous
fix had not closed. No implementation is carried forward; the evidence is.

## Expected Outcome

A named, opt-in posture under which a read-only run completes with zero operator
input, whose containment does not depend on anyone having enumerated the
dangerous programs.

The design constraint, established empirically and not up for re-derivation:
**containment may not be a list of forbidden command words.** A mechanism
satisfies it when the answer to "why can this run not do X?" is a property of the
mechanism — the kernel refused it, the tool was never granted, the command is not
literally one of the exact strings the operator typed — rather than an entry in a
table.

The package's recommended first release: a posture that grants **no shell at
all** and exposes only `risk: "read"` tools. It cannot be defeated by an unknown
wrapper because there is nothing to wrap, it is sufficient for benchmark group A
and the CI case that is waiting, and it is small.

The full attack corpus from the three rounds (C-1 … C-5 in the specification)
ships as a permanent regression suite, run against a real runner and a real
fixture with a real `git init`.

## Out of Scope

- Reaching a policy `deny` by any route.
- Any weakening of the supervised default. A test pins that unflagged behaviour
  is byte-identical.
- The `keryx *` saved-permission hole — real and live, but not reachable from an
  unattended run. It is **flow 138**.
- Making `runOffline` multi-turn.
