# Module src/review

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/review` groups 3 file(s). Depends on `src/flow`, `src/commands`, `src/lib`. Exposes 7 public symbol(s).

## Overview

`src/review` owns the managed-review lifecycle in keryx: it creates, stores, validates, and closes structured review packages that capture the scope, reviewer coverage, findings, learning candidates, and decisions produced by a code-review run. A review package can exist as a standalone artifact under `.metaproject/reviews/` or be attached to an active flow inside `.metaproject/flows/<flow>/reviews/`, making review outcomes first-class citizens of the flow lifecycle. The module bridges the review system with the flow system (`src/flow`) and exposes its operations to CLI commands (`src/commands`).

## How it works

The module is split into two files: `types.ts` declares all branded union types and domain shapes (modes, statuses, target kinds, finding classifications), while `managed.ts` contains every unit of runtime logic that operates on those types.

`managed.ts` organizes its work in three layers. The top layer is the public API surface — `createManagedReviewPackage`, `getManagedReviewStatus`, `completeManagedReview`, and `validateManagedReviewManifest` — each of which takes a `cwd` plus a reference or full input struct and operates on the filesystem. The middle layer is a set of pure builder/renderer helpers (`buildManifest`, `normalizeCoverage`, `normalizeFindings`, `renderScope`, `renderCoverage`, `renderReport`, `renderLearning`, `renderDecisions`) that transform inputs into the concrete files that make up a package. The lowest layer is path resolution: `reviewsRoot` computes the standalone reviews root; `packagePath` selects either the flow-attached path (when mode is `attach-review` or `ingest` and a flow is found) or the standalone root; and `resolveReviewPackagePath` does reverse lookup from a short ref or direct path.

`findRelatedFlow` ties the review module to the flow store: given a target (PR URL, issue URL, or branch name), it walks all known flow directories and returns the first flow whose state matches. This is what lets keryx automatically attach a review to an in-progress flow without requiring an explicit flow ID.

Validation (`validateManagedReviewManifest`) is run synchronously before any files are written during creation, and again before the `closed` status transition during completion. It checks schema version, required string fields, allowed enum values for mode/status/target kind, and the presence of every required artifact path. It also appears to load a JSON Schema document from `docs/requirements/managed-review-feedback-loop/schemas/managed-review-package.schema.json` when that file exists, though the schema is loaded but not actively applied in the current implementation.

## Key concepts

**ManagedReviewPackage** — the primary artifact: a directory on disk containing a `manifest.json` and six Markdown/JSON artifact files (`scope.md`, `coverage.md`, `report.md`, `findings.json`, `learning.md`, `decisions.md`).

**ManagedReviewMode** — controls where a package is stored and how findings are classified. Three modes: `attach-review` (must resolve a flow, stored inside the flow), `review-flow` (standalone, no flow lookup), and `ingest` (imports an external report text and requires one).

**ReviewTargetKind** — the type of artifact being reviewed: `pr`, `issue`, `branch`, `path`, or `report`.

**ReviewPackageStatus** — lifecycle of a package: `draft` → `reviewed` → `decided` → `learned` → `closed`. `completeManagedReview` transitions directly to `closed` after validating all artifacts exist.

**ReviewCoverageEntry** — records which reviewer ran, with a status (`run`, `skipped`, `failed`, `needs_context`) and a human reason. Defaults to a single `review-orchestrator` entry when none is provided.

**NormalizedReviewFinding** — a structured finding extracted from the raw report text by matching `F-NNN` codes. Each finding carries a severity (`blocker`, `major`, `minor`, `info`), a `FindingClassification`, and a `flow_relevance` indicating whether it was found during an active flow or as post-flow or standalone feedback.

**FindingClassification** — categorizes a finding's disposition: `missed_by_flow_gate`, `valid_followup`, `out_of_scope`, `skill_learning_candidate`, or `false_positive`. Findings in the `ingest` mode default to `valid_followup`; all others default to `skill_learning_candidate`.

**FlowMatchResult** — the result of `findRelatedFlow`: includes the matched flow ID, its directory, and the reason for the match (`explicit-flow-id`, `pr-url`, `issue-url`, `branch`, or `none`).

## Main flows

**1. Creating a flow-attached review package (`attach-review` mode)**
A CLI command in `src/commands` calls `createManagedReviewPackage` with `mode: "attach-review"` and a PR URL as the target. `managed.ts` calls `resolvePackageFlow`, which delegates to `findRelatedFlow`; that function walks `listFlowDirs` from `src/flow` and matches the PR URL against `flow.pr.url` for each active flow, returning the flow ID and directory. `packagePath` then places the package inside `.metaproject/flows/<flow-dir>/reviews/<reviewId>/`. `buildManifest` populates the `flow` field with the matched flow's ID and path. After `validateManagedReviewManifest` passes, six files are written atomically to the package directory.

**2. Ingesting an external review report (`ingest` mode)**
A CLI command calls `createManagedReviewPackage` with `mode: "ingest"`, a target, and either `reportPath` or `reportText`. `readReport` reads the text from the provided path or inline string (failing fast if neither is supplied). `normalizeFindings` scans the text line by line for `F-NNN` pattern tokens, extracting severity from keyword presence and defaulting classification to `valid_followup`. The resulting findings populate `findings.json` and seed the `learning.md` and `decisions.md` artifact files. The package is stored under `.metaproject/reviews/<reviewId>/` if no matching flow is found.

**3. Closing a review package**
A CLI command calls `completeManagedReview(cwd, ref)`. `resolveReviewPackagePath` first tries the ref as a direct path, then as a standalone review ID, then walks all flow review subdirectories to find a matching directory name. Once the directory is resolved, `missingArtifacts` checks that all six required files exist on disk; if any are missing, an error is thrown. The manifest is read, its `status` is set to `"closed"` and `updatedAt` refreshed, the updated manifest is validated again, and then written back atomically.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `reviewsRoot` (function)
- `findRelatedFlow` (function)
- `createManagedReviewPackage` (function)
- `getManagedReviewStatus` (function)
- `completeManagedReview` (function)
- `validateManagedReviewManifest` (function)
- `isFindingClassification` (function)

### Key files

- `src/review/managed.ts` - imported by 2, imports 3
- `src/review/managed.test.ts` - imported by 0, imports 3
- `src/review/types.ts` - imported by 2, imports 0

### Depends on

- `src/flow` - 2 import(s)
- `src/commands` - 1 import(s)
- `src/lib` - 1 import(s)

### Depended on by

- `src/commands` - 2 import(s)

### Graph signals

- Files: 3
- Cross-module imports: 4

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/flow](src-flow.md)
- [Module src/commands](src-commands.md)
- [Module src/lib](src-lib.md)

## Changelog

- 1.0.0 - Prose sections enriched by gdwiki enrich workflow. Overview, How it works, Key concepts, and Main flows filled from code reading of `src/review/types.ts` and `src/review/managed.ts`.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
