---
Title: Module src/review
Version: 1.0.2
Type: component
Status: accepted
Summary: "`src/review` groups 6 file(s). Depends on `src/flow`, `src/commands`, `src/lib`. Exposes 18 public symbol(s)."
---

# Module src/review

VerifiedAt: 4e80355f1b9fa8576742d151d54397abbd527b38
VerifiedScope: sha256:65f8792a47e9f2d3134d057866494322ac507748ad0e2a595f17a66575cd79f6

## Summary

`src/review` groups six files and exposes 18 public symbols. It provides review-related types and functionality, with connections to `src/flow`, `src/commands`, and `src/lib`.

## Overview

`src/review` supports managed review packages: structured artifacts that capture a review’s scope, reviewer coverage, findings, learning candidates, and decisions. Packages can be stored as standalone artifacts under `.metaproject/reviews/` or attached to a flow under `.metaproject/flows/<flow>/reviews/`.

The module connects review operations to the flow system and makes them available to CLI commands.

## How it works

The module has six files. `types.ts` defines review-related types, while `managed.ts` contains the managed-package operations. The remaining files cover specialized concerns:

- `pr-comments.ts` — pull request comment integration
- `blast-radius.ts` — impact analysis for findings
- `verification.ts` — verification of review state
- `filter-stats.ts` — filtering and statistical aggregation

The managed-package logic has three broad parts:

- **Package operations:** `createManagedReviewPackage`, `getManagedReviewStatus`, `completeManagedReview`, and `validateManagedReviewManifest` work with review packages and their filesystem representation.
- **Builders and renderers:** Helpers such as `buildManifest`, `normalizeCoverage`, `normalizeFindings`, and the `render*` functions transform review inputs into package artifacts.
- **Path resolution:** `reviewsRoot`, `packagePath`, and `resolveReviewPackagePath` determine where packages are stored and how they are found.

`findRelatedFlow` connects reviews to flows by examining known flow directories for a match against a review target, such as a pull request, issue, or branch. This allows a review to be attached to a matching flow without requiring the caller to provide a flow ID.

Manifest validation runs during package creation and before a package is closed. It checks required fields, supported enum values, schema version, and required artifact paths. The implementation may load a JSON Schema document from `docs/requirements/managed-review-feedback-loop/schemas/managed-review-package.schema.json` when present, but does not apply that schema in the current implementation.

## Key concepts

- **Managed review package:** A directory containing a `manifest.json` and review artifacts: `scope.md`, `coverage.md`, `report.md`, `findings.json`, `learning.md`, and `decisions.md`.
- **Managed review mode:** Controls how a package is created and stored:
  - `attach-review` associates a review with a flow.
  - `review-flow` creates a standalone review without flow lookup.
  - `ingest` imports an external report and requires report text.
- **Review target kind:** Identifies the reviewed item: `pr`, `issue`, `branch`, `path`, or `report`.
- **Review package status:** Describes the package lifecycle: `draft`, `reviewed`, `decided`, `learned`, and `closed`. `completeManagedReview` validates the artifacts and transitions the package to `closed`.
- **Review coverage entry:** Records a reviewer and their status (`run`, `skipped`, `failed`, or `needs_context`), with a reason. When no coverage is provided, coverage defaults to a `review-orchestrator` entry.
- **Normalized review finding:** A structured finding extracted from report text by matching `F-NNN` codes. Findings include severity, classification, and flow relevance.
- **Finding classification:** Describes a finding’s disposition: `missed_by_flow_gate`, `valid_followup`, `out_of_scope`, `skill_learning_candidate`, or `false_positive`. In `ingest` mode, findings default to `valid_followup`; in other modes, they default to `skill_learning_candidate`.
- **Flow match result:** Reports the matched flow, its directory, and the match reason, such as an explicit flow ID, pull request URL, issue URL, or branch.

## Main flows

### Create a flow-attached review package

A CLI command can call `createManagedReviewPackage` with `mode: "attach-review"` and a target such as a pull request URL. The module looks for a matching flow, then stores the package under `.metaproject/flows/<flow-dir>/reviews/<reviewId>/`. The manifest records the matched flow. After validation, the package artifacts are written to the directory.

### Ingest an external review report

A CLI command can call `createManagedReviewPackage` with `mode: "ingest"` and provide either `reportPath` or `reportText`. The report is read from the supplied source; creation fails if neither is available. The module extracts findings from report text by scanning for `F-NNN` tokens, assigns severity based on detected keywords, and defaults classifications to `valid_followup`. If no flow matches, the package is stored under `.metaproject/reviews/<reviewId>/`.

### Close a review package

A CLI command can call `completeManagedReview(cwd, ref)`. The module resolves the reference as a direct path or review ID, including IDs found in flow review directories. It checks that all required artifacts exist, updates the manifest status to `closed` and refreshes `updatedAt`, validates the updated manifest, and writes it back.

---

<!-- keryx:reference:begin v=1 hash=315676248975d5dce5465869b0314d9c955eae76a2ad7de555b758d7808caaef -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `MANAGED_REVIEW_MODES`
- `ManagedReviewMode`
- `REVIEW_TARGET_KINDS`
- `ReviewTargetKind`
- `REVIEW_PACKAGE_STATUSES`
- `ReviewPackageStatus`
- `REVIEW_COVERAGE_STATUSES`
- `ReviewCoverageStatus`
- `FINDING_CLASSIFICATIONS`
- `FindingClassification`
- `ManagedReviewTarget`
- `ManagedReviewFlowRef`
- `ReviewCoverageEntry`
- `ManagedReviewManifest`
- `REVIEW_FINDING_SEVERITIES`
- `ReviewFindingSeverity`
- `REVIEW_FINDING_CONFIDENCES`
- `ReviewFindingConfidence`
- `ReviewFindingClassScope`
- `FINDING_DISPOSITION_STATES`

### Key files

- `src/review/types.ts` - imported by 30, imports 7
- `src/review/scope.ts` - imported by 34, imports 0
- `src/review/managed.ts` - imported by 10, imports 14
- `src/review/cost.ts` - imported by 17, imports 0
- `src/review/conform-state.ts` - imported by 13, imports 3
- `src/review/conform-clauses.ts` - imported by 13, imports 1

### Depends on

- `src/flow` - 17 import(s)
- `src/lib` - 14 import(s)
- `src/security` - 11 import(s)
- `src/gdskills` - 6 import(s)
- `src/testing` - 3 import(s)
- `src/gdgraph` - 2 import(s)

### Depended on by

- `src/commands` - 73 import(s)
- `src/tui` - 26 import(s)
- `src/flow` - 5 import(s)
- `src/learning` - 5 import(s)
- `src/learning/signals` - 2 import(s)
- `scripts` - 1 import(s)

### Dependency basis

- Production imports only: 43 import(s) from test file(s) (e.g. `src/commands/review-comments-cli.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 101
- Cross-module imports: 56
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived and regenerated by `keryx wiki collect --force`. Only existing pages are linked.

- [Wiki Index](../index.md)
- [Module src/flow](src-flow.md)
- [Module src/commands](src-commands.md)
- [Module src/lib](src-lib.md)

## Changelog

- 1.0.2 - Reference refreshed from the code graph (4e80355f).
- 1.0.1 - Reference refreshed from the code graph (5886c474); summary updated to reflect 6 files and 18 public symbols; key files table expanded with all 6 files; Public API section reorganized into Constants and Types groups.
- 1.0.0 - Prose sections enriched by gdwiki enrich workflow. Overview, How it works, Key concepts, and Main flows filled from code reading of `src/review/types.ts` and `src/review/managed.ts`.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
