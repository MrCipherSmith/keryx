# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: B-01 branch — `src/harness/branch/branch.ts` produces append-only `branch-metadata` (valid against `branch-metadata.schema.json` via `src/contracts`): a fork creates a branch carrying `forkEntryId`, `leafEntryId`, and `immutableAncestorIds`; branch ancestry is preserved (SC_R06_BRANCH_TREE); a branch switch is atomic and does NOT mutate prior history; the immutable ancestor set is unchanged after switching/forking.
- AC2: no-merge-v1 — an attempt to merge two branches is rejected with a typed error/decision (v1 does not support merge); the rejection is covered by a negative test and no history is mutated by the rejected attempt.
- AC3: B-02 compaction — `src/harness/branch/compaction.ts` produces a typed `compaction-entry` (valid against `compaction-entry.schema.json` via `src/contracts`) with provenance (`sourceEntryIds` → `derivedEntryId` + `summaryHash`); the evidence-preservation invariant holds: compaction NEVER deletes source history or evidence (it is an append-only derived entry; the source entries and evidence remain present) and NEVER promotes an untrusted summary to authoritative (the derived summary entry is non-authoritative); after compaction the bounded context is rebuildable from the derived entry plus the preserved history (SC_R07_COMPACTION_REBUILDS_REFERENCES); compaction-negatives (attempts to delete history or promote an untrusted summary) are rejected.
- AC4: Determinism / offline — all branch/compaction behavior is deterministic (clock and id are injected; no `Date.now`/`Math.random`/network); it reuses the W7 append-only session (`branch_metadata`/`compaction` entry payloads) and W8 store; tests use no real filesystem write and no network.
- AC5: No regression / reuse / scope — `tsc --noEmit` is clean and the full `bun test` suite is ≥ the pre-change baseline of 817 pass with the new tests green and 0 fail; the W7 session, W8 resume/store, W5 ports, W6 fakes, and `src/contracts` validator are REUSED (not rewritten); no new production dependency (`dependencies` `{}`), no provider SDK, no network; all new code lives under `src/harness/`; the frozen requirements package, `src/eval/`, `src/contracts/`, and ADR-0001…0004 are NOT modified.
