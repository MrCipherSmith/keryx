---
Title: Module src/harness/replay
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/harness/replay` is the effect-free, offline replay for recorded harness runs: it snapshots a run's five recomputable hashes into a replay fixture and later recomputes them, reporting a typed mismatch on any divergence and never falling back to live execution."
---
# Module src/harness/replay

## Summary

`src/harness/replay` is the effect-free, offline replay for recorded harness runs. `replay.ts` snapshots a run's five recomputable hashes into a `ReplayFixture` and later recomputes them to verify the run, returning either `{ ok: true }` or a typed `ReplayMismatch`. The module holds no provider, executor or network handle, so a replay cannot trigger a live effect.

## Overview

This module owns offline validation of recorded harness runs. A completed run is written to disk as a small `HarnessRunRecord`, and later a `ReplayFixture` is built from it and replayed against it to check that the recorded session still hashes the same way. The record deliberately keeps only the hashes and identifying metadata (`runId`, `status`, `recordedAt`), not the full `RunResult`, so raw model and tool output is not written out again.

The code graph identifies three files: `replay.ts` holds the implementation, and `replay.test.ts` and `replay.hardening.test.ts` pin its behavior. `replay.ts` has no imports of its own. Production code under `src/commands` consumes it.

## How it works

The core is a hash comparison. `recomputeHashes` is the single place that derives the replayable surface from a run (`sessionManifestHash`, `eventLogHash`, `toolRegistryHash`, `transcriptHash`, `expectedStateHash`). `buildReplayFixture` and `replayOffline` both go through it, so a fixture and a fresh recomputation of the same run agree by construction, and any edit to the fixture shows up as a divergence.

`replayOffline` walks the `HASH_CHECKS` table in a fixed order: session manifest, event log, tool registry, transcript, then terminal state. The first hash that differs wins, and the table maps that field to a `ReplayMismatch.kind` (`state`, `event-order`, `tool-result`, `provider-transcript`) and a human-readable `detail`. The function is synchronous and takes only the fixture, the recorded run and the deps, so there is no path to a provider or tool executor.

Non-determinism is pushed to the caller. `BuildReplayFixtureDeps` and `ReplayDeps` inject an `idSeq` (used for `fixtureId` and `mismatchId`) and a `clock` (used for `detectedAt`). The module itself does no filesystem, network, `Date.now` or random I/O. Parsing is shape-checked rather than schema-validated: `parseRunRecord` and `parseReplayFixture` check for the five hashes and a non-empty id, and the frozen JSON schemas are not loaded at runtime because an installed CLI may not ship them.

## Key concepts

- **RecomputableRun**: the structural hash surface a fixture binds to. `RunResult` satisfies it, and so does a `HarnessRunRecord` read back from disk, so the same replay code serves in-process runs and recorded ones.
- **ReplayFixture**: the snapshot a replay checks against. `buildReplayFixture` always sets `mode: "validate-log"` and `noSideEffects: true`; Release 0 never selects `isolated-re-execute`.
- **HarnessRunRecord**: the durable on-disk form of a completed run, built by `toRunRecord`. It holds the five hashes plus `runId`, `status` and `recordedAt`.
- **ReplayMismatch**: the typed report for a divergence, carrying `expectedHash`, `actualHash`, the mismatch `kind` and the `detail`. It is returned, not thrown, and replay never recovers from it by running live.
- **ReplayOutcome**: the result of `replayOffline`, either `{ ok: true }` or `{ ok: false; mismatch }`.

## Main flows

1. **Record and snapshot.** A run completes and `toRunRecord` turns it into a `HarnessRunRecord` for the caller to persist. `buildReplayFixture(run, { idSeq })` then produces a schema-shaped `ReplayFixture` with the same hashes, in `validate-log` mode.

2. **Offline replay.** `replayOffline(fixture, run, { clock, idSeq })` recomputes the hashes from the recorded run and compares them in `HASH_CHECKS` order. A full match returns `{ ok: true }`. Any divergence returns a `ReplayMismatch` naming the first differing field, with its `mismatchId`, the fixture id and the timestamp from `clock`.

3. **Verification in tests.** `replay.test.ts` pins the frozen acceptance scenarios for offline replay, mismatch reporting and rejection of live effects. It runs a real `runOffline` with `FakeProvider` and `FakeToolExecutor`, with `fetch` stubbed to throw and the fake provider and executor spied to throw if called. `replay.hardening.test.ts` repeats the replay twice to check that outcomes are identical, that the recorded `events` and `sessionEntries` are unchanged, and that a mismatching fixture still never triggers a live call.

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Key files

- `src/harness/replay/replay.hardening.test.ts` - imported by 0, imports 11
- `src/harness/replay/replay.test.ts` - imported by 0, imports 11
- `src/harness/replay/replay.ts` - imported by 4, imports 0

### Depended on by

- `src/commands` - 1 import(s)

### Dependency basis

- Production imports only: 21 import(s) from test file(s) (e.g. `src/commands/harness.replay.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 3
- Cross-module imports: 0

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/commands](src-commands.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.1 - Generated sections regenerated by `keryx wiki collect --force`; prose untouched.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose sections are drafts for the gdwiki enrich workflow.
