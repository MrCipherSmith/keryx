# Shared Agent Context Improvements Program — Metrics and Validation
Version: 0.1.0

## Purpose

Measure delivery integrity and user/system outcomes without rewarding document,
commit, agent, or tool-call volume.

## Delivery metrics

| Metric | Definition | Desired behavior |
|---|---|---|
| Dependency compliance | starts with prerequisites or approved waiver | 100% |
| Acceptance completion | passed AC / total AC | 100% before complete |
| Required gate pass | passed required gates / required gates | 100% |
| Review blocker closure | resolved blockers / discovered blockers | 100% |
| Reopen rate | reopened / closed findings | reported, decreasing |
| Blocked ratio | blocked active time / total active time | reported by cause |
| Rollback readiness | packages with verified rollback / delivered packages | 100% |
| Evidence completeness | required evidence classes present / required | 100% |

## Product outcome groups

- **Correctness:** plan/manifest equality, stable IDs, freshness, owner projection
  fidelity, exactly-once promotion.
- **Security:** unsafe persistence, identity bypass, hidden disclosure, foreign
  receipt binding, revoked-capability use.
- **UX:** time to first useful context, commands per successful lifecycle,
  proposal review latency, handoff success without fallback search.
- **Efficiency:** independently measured tokens, tools, active time, receipt
  storage, lock latency, duplicate research.
- **Memory:** temporal update, contradiction, abstention, forgetting, privacy
  deletion, applicability.
- **Multi-agent:** duplicate work, handoff loss, coordination overhead,
  verification escape, topology regret.

## Milestone gates

### Milestone 1 — truthful secure local core

RP-12a, RP-01, RP-04, RP-05, and RP-06a complete. Zero P0 security/correctness
regressions; current behavior and rollback are documented.

### Milestone 2 — useful local product

RP-02, RP-03, RP-09, and RP-10 complete. Real tasks show lower or equal time to
useful verified context without increased unsafe persistence.

### Milestone 3 — memory and collaboration

RP-07 and RP-08 complete. Temporal/memory and multi-worktree handoff corpora pass
without Flow duplication or transcript sharing.

### Milestone 4 — evaluation decision

RP-11 completes causal ablations and records explicit decisions for learned
policy, remote capabilities, topology automation, and UI.

## Validation

- Recompute dashboard statistics from child rows and Flow evidence.
- Fail if a `complete` row lacks any required evidence class.
- Fail if an unknown metric is serialized as zero.
- Fail if a P0 blocker is hidden by a completion percentage.
- Sample every child package for requirements/runtime status accuracy.
- Reconcile roadmap and program dashboard at each milestone.

## Reporting cadence

- Per active Flow transition: update package row.
- Weekly while any package is active: reconcile blockers, risk, and evidence.
- At milestone: publish baseline/delta and RP-11 `retain`/`remove`/`defer`
  decisions. Record any later activation as a separate governed approval.
- At program closure: publish final outcomes, removals/deferrals, residual risks,
  and maintenance ownership.
