# Evidence Retrieval PRD
Version: 0.1.0

## Problem, goal and users
Accepted knowledge does not capture every old utterance, experiment or tool
result. Memory semantic reranking cannot discover raw archive evidence. Recalling
already-visible text wastes bounded context; rebuilding unchanged vectors wastes
indexing work. Users: agents reopening investigations, operators tracing old
work and maintainers evaluating retrieval. Goal: recover attributable evidence
without turning it into policy or accepted knowledge.

## Requirements
### R1 — Separate evidence lane
Raw retrieval must not mutate memory/wiki/SAC/Slate or alter their acceptance rules.
Verification: judged

### R2 — Semantic discovery
Union independent lexical and vector pools before fusion; semantic candidates
can have zero lexical overlap. Preserve deterministic lexical-only mode.
Verification: judged

### R3 — Current citations
Each excerpt has source/version/locator/full SHA-256 and explicit untrusted status.
Revalidate existence, permission and hash before delivery.
Verification: judged

### R4 — Exact visible exclusion
Suppress only exact spans proven present in the final serialized model request.
Partial, unknown, transformed and summarized coverage is not exact coverage.
Verification: judged

### R5 — Incremental atomic indexes
Reuse unchanged embeddings; complete-record cursors for compatible append;
rewrites/truncation reprocess sources. Readers cannot see mixed generations.
Verification: judged

### R6 — Deletion and honest absence
Deletion/revocation/retention forbid recall immediately using source checks and
authoritative invalidation ledger. Missing/error/stale differ from no-match.
Verification: judged

### R7 — Privacy and cost
Disabled by default, finite roots and ceilings, no secrets or unapproved remote
embedding. Automatic recall is separately opted in.
Verification: judged

### R8 — Bounded surfaces
Planned CLI and evidence_search tool; automatic retrieval at most once per user
turn and never evicts required policy/latest user message to fit evidence.
Verification: judged

### R9 — Recovery and observability
Corruption/model mismatch/timeout/crash have named safe outcomes and content-free
counters. Disable restores existing behavior; clear removes derived artifacts only.
Verification: judged

### R10 — Measured rollout
Reproducible paired evaluation and adversarial fixtures precede automatic rollout.
Verification: judged

## Success criteria
### Release criteria
- R1–R10 mapped to passing acceptance suites defined in implementation plan.
- Zero unauthorized disclosure, secret leakage, stale citations or raw-policy
  promotion in adversarial fixtures; zero false exact-visible exclusions.
- Incremental/fresh equivalence, crash/concurrency and disabled-mode regressions.
- Documentation check: python3 docs/requirements/keryx-evidence-retrieval/verify.py.
### Outcome criteria
- Recovery usefulness: not measured — runtime/dataset unbuilt. Observe grounded
  answer rate and Recall@10 on held-out questions in P5.
- Context duplication: not measured — instrumentation planned. Observe duplicate
  injected tokens and false exclusions in P5 visibility ablation.
- Index cost: not measured — observe embedding calls/tokens for unchanged and
  append workloads against full rebuild at P5 under the same model.

## Risks and recommendation
Risks: sensitive archives, false authority, stale vectors, scope identity mistakes,
false exclusions and remote cost. Ship explicit local lexical retrieval first,
then incremental hybrid, then opt-in automatic recall after correctness gates.
