# Shared Agent Context — Evaluation and Topology-Aware Orchestration Specification
Version: 0.1.0

## Status and identity

**Future / planned normative specification.** Package ID: `shared-agent-context-evaluation-orchestration` (RP-11). It is an offline/controlled evaluation contract and grants no candidate runtime authority.

## Evaluation unit and corpus

```text
EvaluationCase = {
  caseId, corpusVersion, taskContractRef, sourceRevisionSetDigest,
  taskClass, riskClass, allowedTopologySet, baselinePins,
  budgetProfile, verifierContractRef, securityFixtureRefs,
  split: train | holdout | adversarial | regression
}
```

The corpus is versioned, redacted/minimised, and split before analysis. Each case has independently checkable completion criteria, source revisions, allowed tool/owner boundaries, and a verifier contract. Unsafe, ambiguous, or unverifiable rows are quarantined and excluded from scoring. Evaluated agents do not author their own ground-truth outcome.

## Baselines

| Baseline | Required behavior |
|---|---|
| `sac-off` | Existing non-SAC/control path under the same task contract and budget profile. |
| `deterministic-sac` | Pinned deterministic SAC retrieval/selection policy under the same allowed sources and security policy. |
| `candidate-shadow` | Pinned candidate computes a proposal/score/selection trace only; deterministic-SAC output remains the actual delivered output. |

All three runs retain source/policy/security/topology pins. Candidate-shadow output is stored as bounded evaluation metadata and is not fed to the agent as authority, not used for authorisation, and not consumed by owner writes. A candidate that changes any delivered FWK selection is not shadow-only and fails this specification.

## Independent verifier ownership

`VerifierOutcome` is the only task-success authority:

```text
VerifierOutcome = {
  outcomeId, caseId, runId, verifierOwnerRef, verifierIdentityRef,
  criteriaVersion, verdict: pass | fail | abstain | invalid,
  evidenceRefs, observedAt, conflictOfInterestCheck, outcomeDigest
}
```

Verifier owner/identity must be independent of the evaluated agent execution and candidate producer under the declared conflict policy. The verifier may use project tests, owner-system facts, manual review, or a separately governed verification agent, but not a self-authored completion claim as its conclusion. `abstain` and `invalid` are first-class outcomes and cannot be counted as pass.

## Metrics and causal ablations

Each run records actual measured duration, tool/cost availability, traceable handoffs, reservations, verifier result, security events, and outcome provenance. Required factors for ablation are: SAC availability (`off/on`), selection (`deterministic/candidate-shadow`), coordination support (`none/handoff/reservation`), and topology. A valid contrast changes one factor while keeping case, source revision set, security policy, budget profile, model/provider configuration, and verifier criteria fixed. Otherwise it is `confounded` and cannot support causal claims.

## Topology selection

`TopologyProfile` describes the task's dependency graph, independent subproblem count, shared-write risk, handoff sensitivity, required owner boundaries, and expected verification cost. A policy selects from a bounded set: `single-agent`, `sequential-handoff`, `parallel-independent`, or `hierarchical-review`. Parallel/hierarchical modes are allowed only when tasks have separable scopes, bounded interaction, compatible budgets, and a safe review/fold point. Flow remains the work-state owner in every topology.

Selection evaluates verified benefit against duplicate work, handoff loss, security incidents/denials, elapsed/cost overhead, and verifier burden. It never chooses a topology based only on agent preference or confidence.

## Shadow tournament and decisions

Tournament execution is offline or shadow-only, network/policy constrained, pin-verified, and append-only in results. Candidate policy cannot learn online, alter itself, modify corpus labels, or influence live routing. Results are grouped by task class, corpus split, baseline, and topology.

After independent review, the decision owner emits exactly one of:

| Decision | Meaning |
|---|---|
| `retain` | Continue bounded shadow evaluation because evidence supports further investigation; not live activation. |
| `remove` | Retire candidate/topology experiment from evaluation because harm, no benefit, or unsupported complexity is shown. |
| `defer` | Keep disabled pending missing corpus/verifier/security/overhead evidence. |

Each decision binds evidence digests, scope, owner, decision date, review expiry, and rollback/disable state. There is no `activate` decision in this package and no automatic promotion from a score.

## Planned interfaces and acceptance criteria

Planned interfaces are `evaluation.run`, `evaluation.verify`, `evaluation.ablate`, `evaluation.compare-topology`, `policy.shadow-tournament`, and `policy.decision`. They are future controlled operations, not current CLI/MCP claims.

- Baselines are reproducible and candidate-shadow cannot alter delivered output.
- Verifier ownership is independent and all task-success metrics come from verifier outcomes.
- Duplicate-work, handoff, security, overhead, and topology measures accompany success claims.
- Confounded contrasts are excluded from causal conclusions.
- Tournament conclusion is retain/remove/defer with no online learning, candidate authority, or auto-activation.
