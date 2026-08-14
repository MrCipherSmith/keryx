# Keryx Improvements 1 — implementation plan

**Status:** proposed

**Date:** 2026-08-14

**Source:** `../../report/en/report.md`

## Delivery rule

Deliver each package as a separate requirements package/Flow. Do not combine correctness, evidence security, lifecycle, memory, and multi-agent work into one SAC v2.

## Gate 0 — characterize the baseline

Add failing or decision-pinning tests for candidate output, budget overflow, positional IDs, freshness, note mutation, self-review, idempotency collision, crash recovery, accepted target link-back, mixed collaboration ledger, and sibling worktrees. Pin current evidence to commit/date. Keep learned activation synthetic/off.

## Flow sequence

1. **RP-12 Truth Sync (S):** fix guide/status claims, refresh graph/wiki, execute docs snippets, publish one capability matrix.
2. **RP-01 Runtime Truth (M):** independent retrieval plan/baseline, actual selected-ID execution, mandatory/optional semantics, stable IDs, real detail, honest costs/freshness.
3. **RP-04 Promotion Integrity (M–L):** exhaustive targets, preview digest, no mutable sidecar, independent-review mode, correctly scoped idempotency, restart-safe recovery, path/workspace validation, accepted-target link-back and proposal inbox.
4. **RP-05 Secure Evidence (M–L):** sealed sessions, structured wrap-up, pre-persistence scan/minimization, no full transcript by default, TTL/delete/restricted storage.
5. **RP-06 Local Identity/Guard slice (M):** replace constant pass with live strict provider; pin local-single-user semantics and central transport denial. Remote capability work remains later.
6. **RP-02 Source-owned Projections (M–L):** Flow/evidence/knowledge owner ports and canonical Wiki writer.
7. **RP-03 Lifecycle Binding (M):** `shell --workspace`, `session current`, agent current/list tools, Flow/worktree derivation, completion proposal reminder.
8. **RP-09 Unified Operations (M):** one registry deriving CLI/MCP/Harness/help/docs, consistent enablement/errors, doctor/status/handoff/proposal queue.
9. **RP-10 Receipt Operability (M–L):** context capsules, replay/drift, retention/prune/verify/repair/quota and read-path benchmarks.
10. **RP-07 Memory Lifecycle (L):** generational memory, temporal updates, contradictions, abstention, tombstones, selective forgetting, evaluation corpus.
11. **RP-08 Collaboration/Worktrees (L):** fix/split ledgers, public handoff, causal spine, TTL reservations, clone/base/overlay or portable-bundle model.
12. **RP-11 Evaluation/Policy Decision (M–L):** SAC-off/deterministic/candidate baselines, causal ablations, topology selection, shadow real-data tournament, explicit retain/remove decision.

## First milestone

Flows 1–5. This creates a truthful and secure local-single-user core. Do not start memory/multi-agent expansion until this milestone demonstrates lower time-to-context and no security regression on real tasks.

## Stop conditions

- Secret/PII persists in evidence.
- Candidate attribution changes without output change.
- Acceptance lacks review-bound bytes, owner receipt, or correct idempotency binding.
- Remote transport discovers a workspace without a scoped verified principal.
- A coordination store duplicates Flow state.
