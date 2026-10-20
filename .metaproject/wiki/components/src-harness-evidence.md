---
Title: Module src/harness/evidence
Version: 1.0.1
Type: component
Status: accepted
Summary: "`src/harness/evidence` defines the evidence record shapes the harness links its actions to, and the pure redaction gate that keeps protected content out of persisted evidence."
---
# Module src/harness/evidence

## Summary

`src/harness/evidence` owns the evidence vocabulary for the harness: the `EvidenceRecord` shape that ties a harness action to a hash-addressed artifact, and `redactForPersistence`, a pure gate that masks protected content before anything is persisted. The types in `types.ts` mirror the frozen `evidence-record.schema.json`; the only runtime code is the redaction helper in `redaction.ts`.

## Overview

This module defines what a piece of harness evidence looks like and how sensitive content is kept out of it. `types.ts` holds type-only shapes (`EvidenceRecord` and its causal, artifact and provenance parts) that mirror the frozen `evidence-record.schema.json`, so a constructed record can be validated against that schema unchanged. `redaction.ts` holds the runtime, `redactForPersistence`, which decides what may be written to storage. Its file headers cite acceptance scenario SC_R11 and ADR-0001 item 6, which asks that every meaningful action be linked to a redacted evidence record.

## How it works

The two files do not depend on each other at runtime. `types.ts` is declarations only; its header states it has no runtime, so it carries no determinism concerns. A record is assembled from four parts:

- `EvidenceCausalIds` ties the record to a run, with required `runId`, `sessionId` and `correlationId`, and optional `parentEventId`, `attemptId` and `branchId`.
- `EvidenceArtifactRef` points at the artifact through `artifactId`, `kind`, an optional `path`, and a lowercase sha-256 `hash`.
- `EvidenceProvenance` records a `trustLevel` (`trusted`, `untrusted`, `derived` or `unknown`) and a `sourceKind`, with optional `sourceHash` and `taintIds`.
- `kind` classifies the record with the closed `EvidenceKind` union.

`redactForPersistence(content, deps)` is a pure function of its inputs. The secret scanner is not bundled; it is injected as `deps.scan`, which returns a `ScanResult`. The function branches on that result in a fixed order. A `scanFailed` result is terminal: it returns `{ blocked: true, reason }` and nothing else, so unscanned content cannot leak. A flagged result replaces the preview with a placeholder of the form `[redacted:<category>] N chars withheld` and sets provenance `redaction: "full"`. A clean result keeps the preview verbatim, with category `"none"` and `redaction: "none"`. Every non-blocked result also carries a sha-256 hash of the raw content, which callers can use as an artifact `hash`.

## Key concepts

### Evidence identity

- **`EvidenceRecord`** — The immutable unit of evidence: `schemaVersion` (always 1), `evidenceId`, `causal`, `kind`, `artifact`, `provenance`, and an RFC3339 `recordedAt`.
- **`EvidenceKind`** — A closed union: `context`, `tool-result`, `receipt`, `test`, `health`, `security`, `review`, `completion-gate` and `custom`. The tests check that an invented kind fails schema validation.
- **`EvidenceCausalIds`** — The linkage back to a run. The tests check that a record without it fails schema validation.

### Provenance and artifacts

- **`EvidenceProvenance`** — Trust and source metadata for a record, identified by `provenanceId`.
- **`EvidenceArtifactRef`** — The hash-addressed reference to the artifact the record describes.

### Scanning and redaction

- **`ScanResult`** — What the injected scanner returns: `hasSecret`, an optional `category`, and `scanFailed`. The scanner reports categories only, not spans.
- **`RedactionDeps`** — Holds only `scan: (content: string) => ScanResult`.
- **`RedactionResult`** — A union discriminated on `blocked`. The non-blocked branch carries `preview`, `hash`, `category` and `provenance`; the blocked branch carries only `reason`.
- **`RedactionProvenance`** — Non-sensitive metadata about the redaction: `source: "harness-redaction"`, `category`, and `redaction: "full" | "none"`.

## Main flows

### Redacting content before persistence

1. The caller supplies a `scan` function in `RedactionDeps`. The module does not choose a scanner.
2. `redactForPersistence(content, deps)` calls `deps.scan(content)` once.
3. If the scan reports `scanFailed`, the result is `{ blocked: true, reason }`, and the reason text states that persistence is blocked.
4. Otherwise the preview is masked when `hasSecret` is true and kept verbatim when it is not. The hash and provenance are attached in both cases.

### Building a validated evidence record

The tests show the intended use. A caller takes the `hash` from a non-blocked redaction result as `artifact.hash`, fills in `causal`, `kind` and `provenance`, and checks the record with `validateAgainstSchema("evidence-record.schema.json", ...)` from `src/contracts/validator`. Nothing in this module constructs records or runs that validator; the step is exercised only by `src/harness/evidence/redaction.test.ts`.

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/harness/child](src-harness-child.md)
- [Module src/harness/extension](src-harness-extension.md)
- [Module src/harness/process](src-harness-process.md)
- [Module src/harness/run](src-harness-run.md)
- [Module src/security](src-security.md)

<!-- keryx:reference:begin v=1 hash=30707fd03b02cb119f23418de825b217339e155b38e162df2b2cd330fb4f6a96 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `EvidenceCausalIds`
- `EvidenceArtifactRef`
- `EvidenceProvenance`
- `EvidenceKind`
- `EvidenceRecord`
- `ScanResult`
- `RedactionDeps`
- `RedactionResult`
- `RedactionProvenance`
- `redactForPersistence`

### Key files

- `src/harness/evidence/types.ts` - imported by 7, imports 0
- `src/harness/evidence/redaction.ts` - imported by 4, imports 0
- `src/harness/evidence/redaction.test.ts` - imported by 0, imports 3

### Depended on by

- `src/harness/child` - 1 import(s)
- `src/harness/extension` - 1 import(s)
- `src/harness/process` - 1 import(s)
- `src/harness/run` - 1 import(s)
- `src/security` - 1 import(s)

### Dependency basis

- Production imports only: 5 import(s) from test file(s) (e.g. `src/harness/child/spawn.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 3
- Cross-module imports: 0
<!-- keryx:reference:end -->

## Changelog

- 1.0.1 - Reference and Related Wiki added from the code graph (the page predated them). Hand-written data sections reconciled with the Reference block.
- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.0 — Initial documentation generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z.
