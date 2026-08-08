# Keryx Shell Remediation v2 — Requirements Package
Version: 1.0.0

## Status

**Ready to implement.** Four defects, each with a file, a line and a transcript
behind it. No implementation has started here and no runtime claim is made.
Flow 139 (P3) is already open; the other three need flows.

Source: [the second benchmark run](../keryx-shell-benchmark/findings.md), which
completed group C and all of group A — 42 runs — and found four product defects
and seven defects in the benchmark itself.

## Purpose

v1 made keryx able to **finish** a task. v2 is about whether the answer it
finishes with is **right**, and whether a user can tell what protection they
actually have.

Those are the two themes, and they are not the same problem:

- **P1 and P3 are about correctness.** The graph over-reports cycles because it
  treats a dynamic import as an ordinary edge, and the shell's system prompt
  spends its brevity budget on skipping the check that would have caught it. On
  A3 and again on A4 the *same model* under `opencode` — with no native graph
  tool — gave the better answer, because it verified and keryx did not.
- **P2 and P4 are about honesty of the interface.** The approval menu offers a
  grant that can never be honoured, and a Linux install has no OS containment
  at all while nothing in the installer, the CLI or the output says so.

Nothing here needs new capability built. Every one of the four is a defect in
something that already exists.

## Document Index

- [PRD](prd.md) — problem, users, requirements, success criteria, risks, recommendation.
- [Specification](specification.md) — each defect in detail: evidence, root cause, the change, and its acceptance criteria.
- [Implementation Plan](implementation-plan.md) — flow grouping, ordering, branch policy, and what each flow must not do.

Related, and required reading before implementing:

- [Benchmark findings](../keryx-shell-benchmark/findings.md) — the register, with the method defects kept separate from the product ones.
- [Run 3 runbook](../keryx-shell-benchmark/run-3-runbook.md) — how the fixes get re-measured, and the four decisions that block scheduling it.
- [v1 remediation](../keryx-shell-remediation/README.md) — the package this follows.

## Scope

In scope:

| # | Defect | Area |
|---|---|---|
| P1 | `gdgraph` counts `await import()` as an ordinary import edge | graph |
| P2 | The approval menu offers a prefix grant that can never be honoured | permissions |
| P3 | The shell system prompt trades verification for brevity | agent behaviour |
| P4 | A Linux install has no OS containment and nothing says so | packaging, CLI |

## Non-goals

- **Implementing the domain allowlist on Linux.** `bwrap --unshare-net` gives
  the process its own loopback rather than the one the proxy listens on;
  closing that needs a network namespace plus a relay. That is a feature, not a
  remediation, and it is out of scope here. v2 only makes the *current* state
  visible.
- **Changing what `KERYX_SANDBOX_SHELL` defaults to.** The default-off decision
  has a stated rationale (`shell-exec-tool.ts:10`) and overturning it is a
  product decision, not a defect fix.
- **Fixing the benchmark.** The method defects (M1–M7) belong to the benchmark
  package and most are already fixed there.
- **Group E.** New measurement, not remediation. See
  [proposed-group-e.md](../keryx-shell-benchmark/proposed-group-e.md).

## Related modules

- `keryx-os-sandbox` — P4 touches its documented capability matrix.
- `keryx-shell-benchmark` — produced every finding here and re-measures them.
- `keryx-unattended-posture` — the posture group A runs under.
