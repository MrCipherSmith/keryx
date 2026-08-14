# Shared Agent Context — Evaluation and Topology-Aware Orchestration
Version: 0.1.0

## Status

**Future / planned requirements.** RP-11 specifies evaluation and decision governance only. It does not enable a candidate policy, online learning, autonomous topology changes, or runtime candidate authority.

## Purpose

Determine whether SAC and coordination mechanisms create independently verified value, under which task topologies, and whether an offline candidate policy should be retained, removed, or deferred.

## Document index

| Document | Purpose |
|---|---|
| [README.md](README.md) | Package status, scope, and index. |
| [prd.md](prd.md) | Problem, goal, requirements, risks, and recommendation. |
| [specification.md](specification.md) | Corpus, baselines, verifier, ablation, topology, and tournament contracts. |
| [agent-protocol.md](agent-protocol.md) | Future agent behavior during controlled evaluation. |
| [metrics-and-validation.md](metrics-and-validation.md) | Metrics, acceptance corpus, statistical/causal gates, and decision rules. |
| [implementation-plan.md](implementation-plan.md) | Phased future delivery and explicit decision gates. |

## Scope

- SAC-off, deterministic-SAC, and shadow-candidate baselines.
- Independently owned ground-truth verification and immutable outcome records.
- Duplicate-work, handoff, security, overhead, and task-success measures.
- Causal ablations and topology selection for sequential and multi-agent work.
- Shadow-only policy tournament with retain/remove/defer decisions.

## Non-goals

- Agent self-report as task-success ground truth.
- Online learning, autonomous candidate update, or automatic candidate activation.
- Candidate authority over authorization, security, Flow, owner writes, or acceptance criteria.
- Inferring multi-agent value from task count, output volume, or agent confidence alone.

## Related requirements

- [Shared Agent Context metrics and validation](../shared-agent-context/metrics-and-validation.md)
- [Shared Agent Context policy experiment report](../shared-agent-context/phase-5-policy-experiment-report.md)
- [Keryx Multi-Agent Engine](../keryx-multi-agent-engine/README.md)

## Completion condition

This package is complete as future documentation when its linked files remain versioned, future-statused, and internally consistent. Any policy/topology change requires the gates in [metrics-and-validation.md](metrics-and-validation.md).
