# Shared Agent Context — Evaluation and Topology-Aware Orchestration PRD
Version: 0.1.0

## Status

**Future / planned.** These requirements do not claim that a current candidate changes FWK output or that multi-agent orchestration improves outcomes.

## Problem

Synthetic policy mechanisms can prove a sandbox and pinning process but cannot prove product value when the candidate does not change retrieved output. Multi-agent work also adds coordination cost, duplicate effort, handoff risk, and security surface. Agent summaries and confidence are not independent proof of completed work.

## Goal

Run reproducible evaluations that compare fixed baselines under the same corpus and topology, use independent verifiers as the only task-success authority, identify causal contribution, and produce an explicit retain/remove/defer decision for each candidate and topology policy.

## Users

- Product/engineering owners deciding whether SAC capability should expand.
- Independent verifier owners who validate task outcomes and security invariants.
- Harness/orchestration owners selecting a safe topology for a task class.
- Policy researchers running offline, shadow-only comparisons.

## Requirements

1. Every evaluated case shall execute three named baselines when applicable: `sac-off`, `deterministic-sac`, and `candidate-shadow`.
2. Candidate-shadow shall compute/log a proposed selection only; it shall not alter FWK output, authorization, security decisions, Flow state, owner writes, or runtime routing.
3. Corpus instances, source revisions, task contracts, topology configuration, policy pins, run budget, and verifier criteria shall be versioned and reproducible.
4. An independent verifier owner shall produce the outcome record. Agent self-report, completion claims, token counts, or confidence cannot be the task-success label.
5. Metrics shall include independent task success, duplicate work, handoff quality, security non-regression, overhead/cost/latency, abstention, and verifier disagreement.
6. Causal ablations shall isolate SAC availability, deterministic selection, candidate proposal, handoff/reservation support, and topology choice; comparisons must not confound several changes at once.
7. Topology selection shall be policy-driven from task dependency/parallelism/risk characteristics and compare at least single-agent, sequential handoff, and bounded parallel/hierarchical variants where safe.
8. Tournament results shall end in an explicit `retain`, `remove`, or `defer` decision with evidence, scope, owner, expiry/review date, and rollback state. No score automatically activates a candidate.

## Success criteria

- Every success label is traceable to a verifier artifact independent of the evaluated agent/run.
- Candidate output is demonstrably shadow-only and cannot affect a protected runtime result.
- An ablation can attribute any claimed effect to one declared factor or reports it inconclusive.
- A topology is selected only where verified benefit exceeds coordination/security/overhead cost for that task class.
- Missing/unsafe/inconclusive evidence yields `defer` or `remove`, never automatic activation.

## Risks and recommendation

Evaluations can be gamed by narrow corpora or expensive verifier processes. Use versioned task families, held-out/adversarial cases, blinded/independent verification where feasible, and explicit cost accounting. Keep the candidate in shadow mode until real outcomes show a material, repeatable benefit with no security regression; otherwise remove it rather than growing mechanism complexity.
