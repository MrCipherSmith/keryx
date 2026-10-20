---
Title: Module src/harness/resume
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/harness/resume` groups 7 file(s). Depends on `src/harness/session`, `src/contracts`, `src/harness`. Exposes 5 public symbol(s)."
---

# Module src/harness/resume

## Summary

`src/harness/resume` is the resumable-session layer of `src/harness`. It defines the `SessionStore` boundary that a resume reads a persisted session from, a resume path that decides whether recorded work can continue or must start a new attempt, a bounded retry wrapper over `runOffline`, and a pure crash-recovery classifier. An offline `InMemorySessionStore` backs it today.

**Key facts:**
- 7 files, 8 cross-module imports
- Depends on: [src/harness/session](src-harness-session.md), [src/harness](src-harness.md), [src/contracts](src-contracts.md), [src/harness/provider](src-harness-provider.md), [src/harness/run](src-harness-run.md)
- Exposes 5 public symbols

## Overview

This module owns how a harness session survives interruption. It turns a persisted session back into a live one, decides what a resume may do given the recorded environment fingerprints, retries transient provider failures within a fixed attempt budget, and classifies how to recover from a crash, a torn write or a cancellation. Every source of non-determinism is injected, and storage sits behind an interface, so a durable backend can replace the in-memory store without changing resume logic.

## Key concepts

- **Session snapshot** — `SessionSnapshot`: the authoritative append-only `manifest` and `entries` read back for a resume, plus an optional `checkpoint`.
- **Checkpoint** — `Checkpoint`: a derived recovery view that records the `atEntryId`, `stateHash` and `evidenceLedgerCursor` a recovery may resume against. It never replaces history or evidence, and resume does not require it; `resumeSessionFrom` reads the manifest and entries.
- **Session store** — `SessionStore`: the durable boundary with `read`, `append` (idempotent by `entryId`) and `writeCheckpoint`. Implementations must not mutate a persisted entry.
- **In-memory store** — `InMemorySessionStore`: a `Map` seeded at construction, with no filesystem, clock or network. It serves tests and the offline scenarios.
- **Fingerprints** — the recorded and current environment fingerprints compared by `fingerprintsMatch`. Drift marks the recorded work as stale.
- **Resume reason and attempt** — `ResumeReason` (`continue`, `stale-fingerprint`, `new-work`) and `ResumeResult`. A stale resume starts a new attempt one above the base attempt.
- **Recovery decision** — `RecoveryDecision`, the typed and inert output of `recoverFrom`. The caller enacts it.
- **Typed errors** — `UnknownSessionError` is thrown by the store's `append` and `writeCheckpoint` for an unknown session id. `ResumeSessionNotFoundError` is thrown by `resumeSessionFrom` when the store has no snapshot.

## How it works

### Contracts

`store.ts` defines `SessionStore` and the `Checkpoint` interface, which mirrors `checkpoint.schema.json`. `SessionSnapshot` is also defined in `store.ts`, while `resume.ts` defines `ResumeInput` and `ResumeResult`. The snapshot's `entries` are the source of truth; the checkpoint is an optional side view.

### Persistence

`InMemorySessionStore` keeps snapshots in a map keyed by session id. `append` skips an entry whose `entryId` is already stored, and otherwise advances the manifest's `appendCursor` and `currentLeafEntryId`. `read` returns the live snapshot object, so the resume path treats it as read-only. A different backend would implement the same three methods.

### Resume

`resumeSessionFrom` reads the snapshot, rebuilds the leaf with `resumeSession` from `src/harness/session`, and then compares fingerprints. It never appends, so prior entries and any pending approval are left as they were.

### Retry

`runWithResume` in `resume.ts` calls `runOffline` from `src/harness/run` once per attempt, up to `maxAttempts`. `runOffline` itself is not modified. Events from every attempt are kept, so a failed `provider_error` remains in the trail.

### Recovery

`recovery.ts` holds `recoverFrom`, a pure function that maps an injected `Failpoint` to a `RecoveryDecision`. Its only dependency beyond its inputs is the frozen session-entry schema, which `lastIntactEntryId` uses to find the last entry that still validates. `UnknownSessionError` is defined in `store.ts`.

## Main flows

### 1. Durable resume

1. `resumeSessionFrom` calls `store.read`. A missing snapshot throws `ResumeSessionNotFoundError`.
2. It rebuilds the session with `resumeSession` and derives the base attempt from the distinct `causal.attemptId` values on the entries.
3. With no entries the result is `new-work`. With matching fingerprints it is `continue` at the base attempt. Otherwise it is `stale-fingerprint`, with `attempt` one higher and `startedNewAttempt` set to true.

### 2. Bounded transient retry

1. `runWithResume` runs one `runOffline` attempt, then checks the status.
2. It stops when the status is `completed`, or when no event is a `provider_error` with `retryable: true`.
3. Otherwise it records another attempt, up to `max(1, maxAttempts)`. The result carries the events of all attempts and the number of attempts, and its output is the last attempt's.

### 3. Crash and torn-write classification

1. `recoverFrom` receives a snapshot, a `Failpoint` and, for a post-effect crash, an optional `ExecutionReceipt`. It returns a decision and performs no action.
2. `crash-pre-effect` gives `safe-reexecute`. `crash-post-effect` gives `reconciled` only when the receipt outcome is `effect-confirmed`. Any other outcome, or no receipt, gives `blocked-unknown-outcome` with a reason.
3. `torn-write` gives `recovered-torn-write` at the last entry that validates. `cancellation` gives `cancelled-resumable`, and `isolated-replay-reexecute` gives `replay-deferred`.

## Key Files

| File | Imports | Purpose |
|------|---------|---------|
| `store.ts` | 11 / 1 | Session store interface, `Checkpoint`, `SessionSnapshot`, `UnknownSessionError` and the in-memory implementation |
| `recovery.ts` | 5 / 2 | Pure crash-recovery classifier (`recoverFrom`) and its decision types |
| `resume.ts` | 1 / 8 | Durable resume and bounded retry (`resumeSessionFrom`, `runWithResume`) |
| `resume.test.ts` | 0 / 14 | Tests for core resume behavior |
| `recovery.test.ts` | 0 / 5 | Tests for recovery logic |
| `recovery.hardening.test.ts` | 0 / 5 | Hardening tests for recovery edge cases |

## Related

- [Wiki Index](../index.md)
- [Module src/harness](src-harness.md)
- [Module src/harness/session](src-harness-session.md)
- [Module src/contracts](src-contracts.md)

<!-- keryx:reference:begin v=1 hash=6327fe33b8c49fc8b1fa102a56bc0ddb50c20ef6482e4802bd33ba7ce140a973 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `Checkpoint`
- `SessionSnapshot`
- `SessionStore`
- `UnknownSessionError`
- `InMemorySessionStore`

### Key files

- `src/harness/resume/resume.test.ts` - imported by 0, imports 14
- `src/harness/resume/store.ts` - imported by 11, imports 1
- `src/harness/resume/resume.ts` - imported by 1, imports 8
- `src/harness/resume/recovery.ts` - imported by 5, imports 2
- `src/harness/resume/recovery.hardening.test.ts` - imported by 0, imports 5
- `src/harness/resume/recovery.test.ts` - imported by 0, imports 5

### Depends on

- `src/harness/session` - 3 import(s)
- `src/harness` - 2 import(s)
- `src/contracts` - 1 import(s)
- `src/harness/provider` - 1 import(s)
- `src/harness/run` - 1 import(s)

### Depended on by

- `src/harness/branch` - 2 import(s)
- `src/harness/mutation` - 1 import(s)
- `src/harness/process` - 1 import(s)

### Dependency basis

- Production imports only: 22 import(s) from test file(s) (e.g. `src/harness/branch/branch.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 7
- Cross-module imports: 8
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/harness/session](src-harness-session.md)
- [Module src/harness](src-harness.md)
- [Module src/contracts](src-contracts.md)
- [Module src/harness/provider](src-harness-provider.md)
- [Module src/harness/run](src-harness-run.md)
- [Module src/harness/branch](src-harness-branch.md)
- [Module src/harness/mutation](src-harness-mutation.md)
- [Module src/harness/process](src-harness-process.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill. Hand-written data sections reconciled with the Reference block.
- 0.1.1 - Generated sections regenerated by `keryx wiki collect --force`; prose untouched.
- **0.1.0** — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z
