# Shared Agent Context — Evaluation and Orchestration Metrics and Validation
Version: 0.1.0

## Status

**Future / planned validation.** Metrics require a versioned corpus and independent verifier outputs; no current policy/topology performance claim is implied. Execution metrics for this documentation run are disabled.

## Required metrics

| Metric | Definition | Ground truth |
|---|---|---|
| Verified task success | `pass` verifier outcomes / valid evaluated cases. | Independent `VerifierOutcome` only. |
| Abstention/invalid rate | `abstain` + `invalid` outcomes / cases. | Verifier. |
| Duplicate work | Overlapping independently recorded work scopes or equivalent owner mutations per case. | Causal/reservation/owner receipts, not agent narrative. |
| Handoff fidelity | Handoff artifact references sufficient for verifier completion without unapproved rediscovery. | Verifier plus reference resolution. |
| Security non-regression | New disclosure, unsafe persistence, denied-boundary bypass, or owner-guard failure. | Security/owner tests; required value zero. |
| Overhead | Measured wall time, tool/cost units when available, receipt/coordination/verifier overhead. | Instrumented measurements; `unknown` allowed. |
| Topology efficiency | Verified success and overhead by task class/topology. | Independent verifier + measured data. |
| Candidate agreement | Candidate-shadow proposal agreement with deterministic feasible set. | Closed-output validator; not task success. |

## Causal ablation corpus

For every task class, run paired/replicated cases where one factor changes at a time: SAC off/on, deterministic/candidate-shadow, coordination off/handoff/reservation, and topology. Maintain source revisions, model/provider, budget, security policy, verifier contract, and task contract. Include single-session retrieval, unfamiliar-component work, parallelisable independent work, tightly coupled work, handoff, duplicate-scope conflict, security denial, source drift, and verifier abstention/invalid cases.

| Gate | Required result |
|---|---|
| Baseline parity | SAC-off and deterministic-SAC control paths are runnable from the same case pins. |
| Shadow isolation | Candidate cannot change FWK output, roles, policy, tools, Flow, owner writes, or result routing. |
| Verifier independence | Evaluated agent/candidate producer conflict causes outcome invalidation. |
| Causal validity | A contrast with more than one changed factor is marked confounded and excluded. |
| Security | Any regression invalidates the affected candidate/topology comparison. |
| Multi-agent | Parallel/hierarchical mode demonstrates no unbounded duplicate work and a review/fold point. |

## Tournament decision gate

The decision owner reviews train, holdout, adversarial, regression, and security evidence separately. A candidate/topology may be `retain` only for further shadow study when holdout/adversarial/security gates pass, evidence is non-confounded, verifier independence holds, and benefit/overhead is sufficiently evidenced by policy. It is `remove` on security regression, repeated verifier invalidation, no material verified benefit, or complexity exceeding policy. It is `defer` on missing evidence, inadequate sample/task coverage, unresolved verifier disagreement, or measurement uncertainty.

No aggregate score, agent self-report, candidate agreement, or training result can produce runtime activation. There is no online learning loop: corpus, candidate pin, topology policy, and labels are immutable per tournament run.

## Reporting requirements

Publish a minimised report with corpus and baseline pins, split counts, topology profiles, verifier ownership/conflict checks, metric definitions, uncertainty/confounded exclusions, security results, and final retain/remove/defer decision. Do not publish raw prompts, transcripts, hidden reasoning, credentials, or sensitive source content.
