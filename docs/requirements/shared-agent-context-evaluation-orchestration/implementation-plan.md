# Shared Agent Context — Evaluation and Orchestration Implementation Plan
Version: 0.1.0

## Status

**Future / planned implementation plan.** No phase enables a candidate policy, online learning, or automatic orchestration/topology activation.

## Phase 1 — Corpus and independent verifier contracts

- Define versioned case, source-pin, split, verifier-outcome, conflict-check, and result-report schemas.
- Build representative task classes with held-out, adversarial, security, handoff, duplicate-work, and topology cases.
- Assign verifier ownership independently of evaluated agents/candidate producers and quarantine invalid rows.

**Exit:** no task-success result exists without a valid independent verifier record.

## Phase 2 — Reproducible baselines and shadow isolation

- Implement reproducible SAC-off and deterministic-SAC runners with pinned source/policy/budget/model configuration.
- Implement candidate-shadow computation as write-only evaluation metadata; add tests proving byte-equivalent delivered FWK output and no protected authority change.
- Record actual measured/unknown cost rather than fabricated values.

**Exit:** candidate shadow cannot influence any live result or owner/security boundary.

## Phase 3 — Metrics and causal ablation harness

- Collect verifier outcomes, duplicate-work/handoff/security/overhead measures, and topology profile metadata.
- Add paired/replicated single-factor ablation execution and confounding detection.
- Include security regression as an invalidating gate rather than a weighted score.

**Exit:** each claimed effect has a valid non-confounded contrast or is reported inconclusive.

## Phase 4 — Topology-aware study

- Implement bounded topology profiles and admission rules based on dependency, separability, shared-write risk, and verification burden.
- Compare single-agent, sequential handoff, and safe parallel/hierarchical cases with independent verifier outcomes.
- Preserve Flow ownership, reservations as hints, and bounded review/fold points.

**Exit:** topology choices are justified by verified benefit and cost for declared task classes, not agent preference.

## Phase 5 — Shadow tournament and decision governance

- Run pin-verified offline/shadow tournaments across train, holdout, adversarial, regression, and security splits.
- Have an authorised decision owner emit retain/remove/defer evidence with review expiry and disabled/rollback state.
- Remove/defer unsupported candidates rather than extending their mechanism; never auto-activate.

**Exit:** every tournament has an explicit non-activation decision and auditable evidence references.

## Dependencies and constraints

- Deterministic SAC, receipt provenance, identity/security, and collaboration contracts must be available as test seams before causal claims.
- Candidate policy remains a subset-only, non-authoritative shadow instrument.
- No phase permits online learning, self-report ground truth, automatic candidate promotion, or topology changes outside approved evaluation scope.
