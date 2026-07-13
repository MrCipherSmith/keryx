# Tasks — Flow 012 (W9 branching + compaction)

Task definitions live here; task **statuses** live in flow.json and are managed
only via `keryx flow task done <id> <taskId>`.

Scope: **only W9** (implementation-plan.md §W9). Branch + compaction over W7/W8 —
reuse, do not rewrite. Deterministic/offline; no new dep/SDK/network/real-fs; no
branch MERGE (no-merge-v1). Worktree-guard in every worker.

| ID | Kind | Model | Title / definition |
|----|------|-------|--------------------|
| T1 | context | Haiku | Invariant + module map (context.md). |
| T2 | implement | — | Umbrella: implement per plan (closed when T6+T8 done). |
| T3 | test | — | Umbrella: TDD tests (closed when T5/T7 authored + impls green). |
| T4 | review | — | Umbrella: self-review + completion prep (closed when T9 + completion done). |
| T5 | test (B-01 RED) | Sonnet | `src/harness/branch/` tests: append-only `branch-metadata` (schema-valid); fork creates a branch with forkEntryId/leafEntryId/immutableAncestorIds; ancestry preserved (SC_R06_BRANCH_TREE); branch switch atomic + no history mutation; immutable ancestors unchanged; **no-merge-v1** (merging two branches rejected/typed). RED before T6. |
| T6 | impl (B-01) | Opus | `src/harness/branch/branch.ts`: fork/leaf/immutable-ancestors, atomic switch, no-merge-v1; append-only `branch_metadata` entry over W7 session + W8 store. Make T5 green. |
| T7 | test (B-02 RED) | Sonnet | `src/harness/branch/compaction.test.ts`: typed `compaction-entry` (schema-valid) with provenance (sourceEntryIds→derivedEntryId+summaryHash); evidence-preservation (source history/evidence NOT deleted; untrusted summary NOT promoted to authoritative); rebuild bounded context after compaction (SC_R07); compaction-negatives (attempt to delete/promote) rejected. RED before T8. |
| T8 | impl (B-02) | Opus | `src/harness/branch/compaction.ts`: typed compaction-entry + evidence-preservation validation + rebuild bounded context. Make T7 green. |
| T9 | review | Opus | code-verifier (`tsc` + full `bun test` ≥817 + new green); B-01/B-02 scenario coverage; invariants (no-merge-v1, no-evidence-deletion, no-untrusted-promotion, no-history-mutation); determinism/offline (no Date.now/Math.random/network/real-fs); `deps {}`; W7/W8/W5/W6/src-contracts reused not rewritten; frozen requirements pkg + src/eval + src/contracts + ADRs untouched. |
