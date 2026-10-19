# Module src/learning

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/learning` is the core of the self-learning loop: it defines the learned-pattern record model, stores those records in a project scope and a user scope, and runs the extraction pass that turns observation events into `candidate` patterns. Only the accept path that holds an accept capability can move a record to `accepted`; the store refuses every other such write. Depends on `src/lib`, `src/learning/signals`, `src/review`.

## Overview

`src/learning` owns the learned-pattern record model and its two stores: project records under `.metaproject/data/learning/candidates/` and user records under `<home>/.keryx/learning/patterns/`. It also owns the extraction pass (`runExtract` in `extract.ts`) that reads a window of observation events and creates or reinforces `candidate` records. Its central rule is that a record may become `accepted` only through the capability-gated accept path, and this is enforced in code rather than by convention.

## How it works

The module is layered from the bottom up. `types.ts` holds the type-only surface for `LearnedPattern`, `ObservationEvent` and `IndexEntry`, and `paths.ts` maps record ids and scopes to files. `assertValidLearningId` restricts ids to `LEARNING_ID_PATTERN`, and `assertInsideLearningRoot` bounds every write to a learning root.

`store.ts` is the single write choke point. Its internal `writeRecordUnlocked` validates the record, requires the accept capability for any `status: "accepted"` write (unless the stored copy is already accepted), refuses to change the trigger or action text of an accepted record, checks the path, and writes through `writeContained`. The two public read-modify-write entry points, `updatePattern` and `createPattern`, take the scope's file lock and then call this function. `writePattern` and `writeIndex` are the low-level primitives, and `index.ts` deliberately does not re-export them.

`accept-capability.ts` issues a branded token from `createAcceptCapability`, and `isAcceptCapability` checks it. The token is unforgeable only by import discipline: a source audit asserts that only `store.ts`, `accept.ts` and tests import this file.

`extract.ts` sits on top of the store. It runs the deterministic signals imported from `./signals` (`FAILING_TO_PASSING_TEST_SIGNAL`, `REVERTED_EDIT_SIGNAL`, `REPEATED_CORRECTION_SIGNAL`, `REVIEWER_COMMENT_SIGNAL`, `HEALTH_REGRESSION_SIGNAL`), and may run an optional capability-gated `ModelExtractor` port when no deterministic signal fired. It never writes `accepted`. `index.ts` is the public facade that re-exports the pieces and leaves out the accept capability and the raw write primitives.

## Key concepts

- **Learned pattern** (`LearnedPattern`): a `trigger` and `action` text pair with a `domain` (a `LearningDomain` union such as `testing` or `review-conventions`), a `scope` (`project` or `user`), a `project` identity, a numeric `confidence`, and a `status`.
- **Status lifecycle**: `candidate`, `accepted`, `rejected`, `superseded` or `expired`. Only `candidate` records carry a `ttl` (30 days, set by `CANDIDATE_TTL_DAYS` in `extract.ts`). Extraction skips records that are rejected, superseded or expired.
- **Evidence** (`EvidenceItem`): each item has a `kind` of `reinforcement` or `contradiction`, a `sourceRef` that is a project-relative path and never raw quoted text, and an optional `weight`. Evidence is deduplicated by `sourceRef`.
- **Confidence and level**: `confidence` moves through `applyEvidence` and `applyDecay`, and `confidenceLevel` is derived from it by `confidenceLevelFor`. Deterministic and model-backed drafts seed at different values (`SEED_DETERMINISTIC`, `SEED_MODEL_BACKED`), and model-backed evidence weight is capped at 0.5 in `runExtract`.
- **Deterministic id** (`deterministicPatternId`): `<domain>.<slug>-<sha8>`, where the hash covers the domain and normalized trigger. The slug is only a readable hint, so identity and dedup do not depend on it.
- **Observation event** (`ObservationEvent`): one JSON line per event under `observations/<date>.jsonl`. It stores digests and bounded previews, and the optional `edit` field is hash-only, so raw input and diff content never reach the store.
- **Project identity** (`ProjectIdentity`): a sha256 of the normalized remote URL, or of the worktree path as a fallback. Its `displayName` is a label for the review UI and is never used for identity.
- **Store errors** (`LearningStoreError`): each refusal carries a reason string, such as `learning-accept-capability-required`, `learning-accepted-text-immutable` or `learning-record-identity-mismatch`.

## Main flows

1. **Extraction pass (`runExtract`)**. It first runs the observation-file prune pass, then loads the review-learning config. A malformed config does not abort the run, and it only disables the `reviewer-comment` signal. Next it runs `decayExistingRecords`, which applies decay to candidate and accepted records through `updatePattern`. It then loads the observation window (default 30 days) and runs the deterministic signals. If none fired and the model extractor is enabled, it runs the model extractor. Each draft goes to `upsertDraft`, which skips decided records, deduplicates evidence, runs `scanLearnedText`, and gates reviewer logins through `gateReviewerText`. A new draft becomes a `candidate` via `createPattern`, and an existing one is reinforced via `updatePattern`.
2. **Changing an existing record (`updatePattern`)**. Under the scope lock, it reads the stored record, applies the caller's mutator, and refuses any change to id, scope, project identity or `createdAt`. For an accepted record it also refuses changes to trigger or action text, the addition of a `ttl`, and changes to `domain`, `status`, `supersededBy`, `reviewerProfile`, `redaction`, `provenance` or `schemaVersion`. It then calls `writeRecordUnlocked`.
3. **Reading a record (`readPattern` and `listPatterns`)**. `readPattern` reads the file, validates it, and refuses content whose own `id` or `scope` differs from the requested identity. `listPatterns` skips such files with a warning rather than returning them under the filename's identity.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `applyDecay`
- `applyEvidence`
- `confidenceLevelFor`
- `CONTRADICT_RATE`
- `DECAY_RATE`
- `LEVEL_HIGH_MIN`
- `LEVEL_MEDIUM_MIN`
- `MAX_EVIDENCE_WEIGHT`
- `REINFORCE_RATE`
- `SEED_DETERMINISTIC`
- `SEED_MODEL_BACKED`
- `normalizeRemoteUrl`
- `resolveProjectIdentity`
- `assertInsideLearningRoot`
- `assertValidLearningId`
- `candidatesDir`
- `decisionsLogPath`
- `graduationDir`
- `learningDataDir`
- `LEARNING_ID_PATTERN`

### Key files

- `src/learning/types.ts` - imported by 31, imports 0
- `src/learning/store.ts` - imported by 22, imports 6
- `src/learning/extract.ts` - imported by 4, imports 17
- `src/learning/index.ts` - imported by 1, imports 20
- `src/learning/paths.ts` - imported by 14, imports 1
- `src/learning/accept-capability.ts` - imported by 14, imports 0

### Depends on

- `src/lib` - 18 import(s)
- `src/learning/signals` - 7 import(s)
- `src/review` - 5 import(s)
- `src/security` - 3 import(s)
- `src/gdskills` - 1 import(s)
- `src/agents` - 1 import(s)

### Depended on by

- `src/commands` - 5 import(s)
- `src/learning/signals` - 3 import(s)
- `src/bundle` - 1 import(s)
- `src/lib` - 1 import(s)

### Dependency basis

- Production imports only: 21 import(s) from test file(s) (e.g. `src/commands/learn.test.ts`) excluded from the two sections above in both directions.

### Entry points

- `src/learning/index.ts`

### Graph signals

- Files: 45
- Cross-module imports: 35

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)
- [Module src/learning/signals](src-learning-signals.md)
- [Module src/review](src-review.md)
- [Module src/security](src-security.md)
- [Module src/gdskills](src-gdskills.md)
- [Module src/agents](src-agents.md)
- [Module src/commands](src-commands.md)
- [Module src/bundle](src-bundle.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-10-19T10:13:19.815Z. Prose sections are drafts for the gdwiki enrich workflow.
