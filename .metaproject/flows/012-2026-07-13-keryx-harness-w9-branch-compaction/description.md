# Flow 012 — W9 branching + compaction (B-01, B-02) — Release 1

Status: formalized
Source: user description (harness runbook, Phase 9 — Release 1)

## Problem

The W7 session has `branch_metadata`/`compaction` entry-payload variants but no
logic to fork branches, preserve immutable ancestry, or compact history safely.
W9 adds branching (B-01) and typed compaction (B-02) over the W7 append-only
session + W8 store: fork/current-leaf with immutable ancestors and a no-merge-v1
rule; a typed compaction entry with provenance whose evidence-preservation
invariant guarantees no history/evidence is ever deleted and no untrusted summary
is ever promoted to authoritative.

## Expected Outcome

- **B-01 (implement)** — append-only `branch-metadata` (fork/current-leaf,
  immutable ancestors); branch switch is atomic and preserves ancestry; merging
  two branches is rejected (no-merge-v1).
- **B-02 (implement)** — a typed `compaction-entry` with provenance
  (sourceEntryIds → derivedEntryId, summaryHash) whose evidence-preservation is
  validated: compaction never deletes history/evidence and never promotes an
  untrusted summary; bounded context is rebuildable after compaction (SC_R07).

## Out of Scope (do NOT touch)

- Any wave other than W9. No mutation/approval (W10), flow integration (W11),
  child (W12), parallel (W13), real provider (W14), hardening (W15). No branch
  MERGE (explicitly deferred — no-merge-v1).
- Rewriting W7 session, W8 resume/store, W5 ports, W6 fakes, or the src/contracts
  validator — REUSE them.
- The frozen requirements package + frozen ADR-0001…0004 — read/cite only.
- No new production dependency; no provider SDK; no network; no real fs write in
  tests; determinism preserved.
