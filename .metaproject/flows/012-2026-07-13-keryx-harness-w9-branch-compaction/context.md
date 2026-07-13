# Context — Flow 012 (W9 branching + compaction)

Collected by `keryx flow init` and enriched for W9. (T1 context.) Release 1.

## Baseline
- `bun test` = 817 pass / 0 fail; `tsc --noEmit` clean; deps `{}`. Branch @ c279e3a.

## Build on (reuse — do NOT rewrite)
- W7 `src/harness/session/{session,types}.ts`: `AppendOnlySession`, content-fingerprint dedup, `SessionEntryPayload` (already includes `branch_metadata` + `compaction` variants), `SessionManifest`/`SessionEntry` (causal {runId,sessionId,correlationId,parentEventId?}).
- W8 `src/harness/resume/{store,resume}.ts`: `SessionStore`, `InMemorySessionStore`, `SessionSnapshot`, `Checkpoint`, `resumeSessionFrom`.
- W5 ports, W6 fakes, `src/contracts` validator (`validateAgainstSchema`/`validateAgainstSchemaObject`).

## Scenarios (acceptance.feature)
- B-01 (1): SC_R06_BRANCH_TREE (preserve branch ancestry).
- B-02 (2): SC_R06_TYPED_COMPACTION (compact as a typed derived entry), SC_R07_COMPACTION_REBUILDS_REFERENCES (rebuild bounded context after compaction).

## Schemas (validate durable payloads via src/contracts)
- `branch-metadata`: schemaVersion, branchId, sessionId, forkEntryId, leafEntryId, **immutableAncestorIds**, createdAt.
- `compaction-entry`: schemaVersion, compactionId, sessionId, **sourceEntryIds**, derivedEntryId, **summaryHash**, evidenceLedgerCursor, createdAt.
- checkpoint (W8), session-manifest/entry.

## Invariant map
- **Branch (B-01):** append-only branch-metadata; `forkEntryId` (fork point), `leafEntryId` (current), `immutableAncestorIds` (frozen ancestry). Switch = atomic pointer change, NO history mutation; ancestry preserved. **no-merge-v1**: merging two branches is rejected (deferred).
- **Compaction (B-02):** typed compaction-entry with provenance (`sourceEntryIds`→`derivedEntryId`+`summaryHash`). **Evidence-preservation:** source history/evidence NEVER deleted (append-only derived entry; sources remain), untrusted summary NEVER promoted to authoritative (derived entry non-authoritative). After compaction, bounded context rebuilds from derived + preserved history (SC_R07).

## Target modules (src/harness/branch/)
- `branch.ts` (B-01) — fork/leaf/immutable-ancestors, atomic switch, no-merge-v1; append-only `branch_metadata` entry.
- `compaction.ts` (B-02) — typed `compaction-entry`, evidence-preservation, rebuild bounded context.

## Decisions (approved)
- Modules in `src/harness/branch/`. Reuse W7 session + W8 store + src/contracts; NO rewrite, NO new port/validator/dependency, NO network/SDK; deterministic (inject clock/id — no Date.now/Math.random); no real fs in tests.

## Operational
- keryx = `bun ./src/cli.ts`; new worktree needs `bun install`. Never commit to main.
- State only via `keryx flow`; workers via subagent-dispatch/result (STATUS: first line).
- WORKTREE-GUARD: every writing worker `cd /Users/Goodea/goodea/keryx/.claude/worktrees/feature-keryx-harness-impl && pwd` first, write ONLY under it. Verify after each. fetch-mocks `as unknown as typeof fetch`; guard array indexing.
- TDD order: B-01 (T5→T6), B-02 (T7→T8), review T9.
