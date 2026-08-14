# Shared Agent Context Improvements Program — Implementation Plan
Version: 0.1.0

## Status

Future program plan. Documentation readiness does not imply runtime delivery.

## Operating model

- One child package, managed Flow, worktree, review bundle, verification bundle,
  and rollback proof per implementation unit.
- Freeze acceptance criteria before implementation.
- Run only dependency-independent packages in parallel.
- Merge shared-contract owners before their consumers.
- Update [progress dashboard](progress-dashboard.md) from Flow evidence at every
  state transition.
- Use [phase prompts](phase-execution-prompts.md) rather than ad hoc agent tasks.

## Wave 0 — Baseline and truth sync

### RP-12a Documentation Taxonomy, Evidence, and Coverage

Deliver SAC graph/wiki coverage, capability and status taxonomy, commit-pinned
verification evidence, and current-behavior claim checks that do not depend on
the future RP-09 operation registry.

**Exit:** current behavior and every known gap have a verified source/evidence
anchor; documentation no longer claims unsupported runtime state.

## Wave 1 — Truthful secure local core

After RP-12a, these isolated slices may start in parallel:

- **RP-01 Runtime Truth:** independent deterministic plan, executed selection,
  mandatory/optional semantics, stable IDs, honest freshness/cost/detail.
- **RP-05 Secure Evidence:** sealed session and minimal guarded wrap-up.
- **RP-06a Live Local Policy:** real strict provider and explicit local mode;
  remote remains denied.

RP-04 Promotion Integrity may characterize failures in parallel, but its final
owner/link-back contract integrates after RP-01 descriptor identity is stable.

**Milestone 1 exit:** RP-12a, RP-01, RP-04, RP-05, and RP-06a complete; zero open
P0 blockers; rollback verified; no learned candidate or remote enablement.

## Wave 2 — Useful local product

Parallel after Milestone 1:

- **RP-02 Source-owned Projections:** typed owner descriptors/detail and Wiki
  owner writer.
- **RP-10 Receipts and Provenance:** capsules, retention, replay, repair, quotas,
  durability and SLOs based on RP-01 contracts.

Then sequentially:

1. **RP-03 Lifecycle Binding** after RP-02 and RP-04 contracts.
2. **RP-09 Unified Operations** after RP-03 plus RP-06a.
3. **RP-12b Generated operation truth** after RP-09: generate CLI/MCP/Harness
   operation docs and executable examples from the registry, then enable CI
   parity/drift gates.

**Milestone 2 exit:** RP-12b is complete and one coherent local create → read → detail → wrap-up →
preview → review → owner write → link-back journey passes real-task UX and
security baselines.

## Wave 3 — Memory and collaboration

After Milestone 2, run in parallel:

- **RP-07 Generational Memory** after RP-02 and RP-05.
- **RP-08 Collaboration and Worktrees** after RP-03 and RP-06a.

**Milestone 3 exit:** temporal memory and multi-worktree handoff corpora pass;
no raw transcript bus, duplicate Flow state, or implicit filesystem authority.

## Wave 4 — Evaluation and product decisions

### RP-11 Evaluation and Topology-aware Orchestration

Run SAC-off/deterministic/candidate baselines, causal ablations, topology
evaluation, security non-regression, and real independently verified tasks.

**Exit:** explicit retain/remove/defer decisions for learned policy, automatic
topology, remote capabilities, shared live worktree state, and UI.

## Conditional Wave 5

Start only after RP-11 evidence is recorded and a separate governing owner has
approved a new/major requirements package. An RP-11 `retain` decision permits
only further bounded shadow evaluation; it is not an activation decision:

- RP-06b remote delegated capabilities;
- real learned-policy tournament/activation;
- UI/IDE surfaces;
- cross-project federation.

Each requires a new requirements package or a major-version update; none is
implicitly authorized by this plan.

## Common implementation phases per child package

1. **Initialize:** create Flow/worktree; pin requirements version and baseline.
2. **Characterize:** add failing tests/falsifiers for confirmed gaps.
3. **Design:** freeze contracts and integration checkpoints.
4. **Implement:** deliver smallest vertical slice; no unrelated cleanup.
5. **Integrate:** update dependent adapters and migrations in declared order.
6. **Review:** logic, security, architecture, package-specific and strict pass.
7. **Verify:** tests, type/lint/build, security, health, docs and rollback.
8. **Complete:** publish evidence, update roadmap/dashboard/current docs, merge.
9. **Observe:** measure outcome delta and reopen/rollback if gates regress.

## Shared stop conditions

Stop the active package/wave when:

- a secret, PII, raw transcript, or hidden reasoning is persisted outside the
  explicitly approved restricted evidence contract;
- candidate policy attribution appears without an output-changing plan;
- an idempotency retry can bind a receipt from another proposal/intent;
- accepted bytes differ from the reviewed digest;
- remote or cross-workspace discovery occurs without verified scoped identity;
- a coordination or memory store duplicates Flow or owner knowledge state;
- required rollback evidence is unavailable;
- an open P0 blocker is masked by aggregate progress.

## Program rollback order

1. Disable candidate/remote/optional adapters.
2. Restore the last pinned deterministic local behavior.
3. Preserve permitted metadata-only evidence and owner data.
4. Revoke capabilities and invalidate derived context.
5. Use owner correction paths; never rewrite Flow or accepted knowledge through
   the program layer.
6. Mark dashboard state `rolled-back` with incident and recovery evidence.
