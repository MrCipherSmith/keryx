# Implementation Plan — Flow 012 (W9 branching + compaction)

Status: frozen scope (W9 only) — Release 1

## Approach

Add branching (B-01) and typed compaction (B-02) in `src/harness/branch/` over the
W7 append-only session + W8 store, test-first. Append-only branch metadata with
immutable ancestry and a no-merge-v1 rule; a typed compaction entry with
provenance whose evidence-preservation invariant guarantees no history/evidence
deletion and no untrusted-summary promotion. Reuse W7/W8/src-contracts — no
rewrites, no new dependency, deterministic, offline.

## Worker routing & Model Policy

| Task | Kind | Worker | Model |
|---|---|---|---|
| T5 (B-01 RED) | test | tests-creator | **Sonnet** |
| T6 (B-01) | implement | task-implementer | **Opus 4.8** |
| T7 (B-02 RED) | test | tests-creator | **Sonnet** |
| T8 (B-02) | implement | task-implementer | **Opus 4.8** |
| T9 | review | review-orchestrator | **Opus 4.8** |
| T2/T3/T4 | umbrella | orchestrator | Opus |

Orchestrator = Opus. Workers via `subagent-dispatch` → `subagent-result`, each with
the worktree-guard (cd + pwd).

## Steps

1. T1: invariant + module map (context.md).
2. T5 (B-01 RED): branch metadata/fork/leaf/immutable-ancestors/atomic-switch/
   no-merge-v1 tests (SC_R06_BRANCH_TREE).
3. T6 (B-01 GREEN): `src/harness/branch/branch.ts` — append-only branch metadata +
   no-merge-v1. Reuse W7 session (branch_metadata payload) + W8 store.
4. T7 (B-02 RED): typed compaction/provenance/evidence-preservation/rebuild tests
   (SC_R06_TYPED_COMPACTION, SC_R07_COMPACTION_REBUILDS_REFERENCES).
5. T8 (B-02 GREEN): `src/harness/branch/compaction.ts` — typed compaction-entry +
   evidence-preservation + rebuild bounded context.
6. T9: `tsc` + full `bun test` (≥817 + new green); B-01/B-02 coverage; invariants
   (no-merge-v1, no-evidence-deletion, no-untrusted-promotion); determinism/offline;
   `deps {}`; reuse-only; frozen + src/eval + src/contracts untouched.
7. `keryx health run`; confirm ACs; completion choice (ask user A/B/C).

## Verification (TDD)

Each task RED before impl, GREEN after. Gate: `tsc` clean; full `bun test` ≥817 +
new green; branch/compaction payloads schema-valid; invariants asserted; no real
fs; no new dependency.

## Risks

- **Evidence loss on compaction** → compaction is an append-only DERIVED entry;
  source entries + evidence remain; AC forbids deletion; tests assert the source
  entries + evidence survive and are rebuildable.
- **Untrusted summary promotion** → the compaction summary is a non-authoritative
  derived entry (never replaces authoritative history); tests assert it is not
  promoted.
- **History mutation on branch switch** → switch is an atomic pointer change over
  append-only entries; immutable ancestors asserted unchanged.
- **Accidental merge support** → no-merge-v1: merge is rejected (typed); test.
- **Rewriting W7/W8** → additive `branch/` module; if a W7/W8 change seems needed,
  STOP and report (prefer composition).
- **Wrong-worktree / tsc-cast / index-guard** → guard directives in every dispatch.
