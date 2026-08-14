# Shared Agent Context Improvements Program — PRD
Version: 0.1.0

## Problem

The analysis produced twelve valid but interdependent improvement packages.
Executing them as one project would create a large blast radius and make it
impossible to know which change improved correctness, security, usability, or
agent performance. Executing them independently without a program contract
would create the opposite failure: dependency violations, duplicated work,
incompatible contracts, stale status, and no reliable aggregate progress.

## Goal

Give a human or agent a reproducible way to implement the packages in safe
dependency order, track real progress and evidence, stop on failed gates, and
make explicit product decisions before expensive multi-agent, learned-policy,
remote, or UI work.

## Users

- Program owner deciding priorities and stop/go gates.
- Flow orchestrator creating and tracking implementation work.
- Implementing agents working on one bounded package.
- Reviewers validating correctness, security, architecture, and documentation.
- Maintainers tracking aggregate progress and operational evidence.

## Program requirements

- **PG-1 — Independent delivery.** Every child package has a separate Flow,
  branch/worktree, frozen acceptance criteria, review, verification, and
  rollback evidence.
- **PG-2 — Dependency enforcement.** A package may start only when its declared
  prerequisite gates are complete or explicitly waived with owner rationale.
- **PG-3 — Truth before expansion.** Documentation truth-sync, baseline
  characterization, runtime correctness, promotion integrity, secure evidence,
  and live local policy precede lifecycle, memory, collaboration, learned
  policy, remote transport, and UI expansion.
- **PG-4 — Evidence-based progress.** Status is derived from accepted Flow and
  verification artifacts, not agent narrative or code volume.
- **PG-5 — Shared dashboard.** The program records package/phase state,
  dependency readiness, blockers, risk, verification, review, delivery dates,
  and rollback readiness.
- **PG-6 — Aggregate metrics.** Track completion, cycle time, blocked time,
  acceptance pass rate, reopened findings, risk retirement, security incidents,
  and product outcome deltas.
- **PG-7 — Prompted operation.** Copy-ready prompts cover initialization,
  planning, implementation, review, verification, completion, rollback, and
  program reconciliation for every child package.
- **PG-8 — Wave limits.** Parallel work is permitted only for packages whose
  owned files/contracts do not overlap and whose dependencies are satisfied.
- **PG-9 — Stop conditions.** Security disclosure, false policy attribution,
  foreign receipt binding, accepted unreviewed bytes, remote discovery without
  identity, or duplicate Flow state stops the affected wave.
- **PG-10 — Decision gates.** Learned policy, shared worktree state, remote
  capabilities, and UI each require an explicit owner decision backed by the
  preceding evaluation package.
- **PG-11 — Honest status.** Package states are `not-started`, `planning`,
  `implementing`, `review`, `verification`, `blocked`, `complete`, or
  `rolled-back`. Documentation readiness is never called runtime completion.
- **PG-12 — Program closure.** The program completes only when every accepted
  package is complete or explicitly removed/deferred with rationale and the
  final outcome report is reviewed.

## Success criteria

- Twelve child packages are represented in the dashboard with owners,
  dependencies, prompts, gates, and evidence links.
- No implementation starts before its prerequisites without a recorded waiver.
- Every completed package has passing acceptance, review, verification, and
  rollback evidence.
- Aggregate status can be recomputed from package artifacts.
- The first milestone demonstrates a truthful secure local SAC core before any
  later expansion is authorized.
- The final policy decision retains or removes learned runtime activation based
  on measured output/task benefit rather than sunk cost.

## Risks

- Too much governance can slow small corrective changes.
- Shared contracts may evolve while dependent packages are still drafts.
- Aggregate percentages can hide one unresolved P0 blocker.
- Parallel agents can produce superficially compatible but semantically
  conflicting contracts.
- The program may continue because work was invested rather than because user
  outcomes improved.

## Recommendation

Run a truth-and-security milestone first, followed by the useful local-product
milestone. Treat memory, worktree collaboration, learned policy, remote identity,
and UI as conditional expansion. Keep the dashboard evidence-derived and show
P0 blockers separately from completion percentages.
