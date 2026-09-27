---
Title: Module src/harness/evidence
Version: 0.1.0
Type: component
Status: draft
Summary: "`src/harness/evidence` groups 3 file(s). Depends on `src/contracts`. Exposes 10 public symbol(s)."
---
# Module src/harness/evidence

## Summary

`src/harness/evidence` provides the shared contract layer for evidence created, scanned, referenced, and redacted by harness-related modules. It defines typed objects that describe evidence: its kind, provenance, artifact linkages, causal relationships, scan outputs, and redaction transformations.

## Overview

This module centralizes evidence-related type definitions used across the harness and security subsystems. By exposing a common vocabulary through `src/harness/evidence/types.ts`, other modules can exchange evidence data without duplicating interface definitions.

The module also provides redaction functionality through `src/harness/evidence/redaction.ts`, including the [`redactForPersistence`](#public-api) helper for preparing evidence before storage.

Because evidence often carries sensitive data — file contents, process output, secrets caught mid-flight — this module's redaction layer is a deliberate boundary: anything written to durable storage should pass through it first.

## How it works

The module consists of three files:

| File | Purpose | Import relationships |
|------|---------|---------------------|
| `types.ts` | Core evidence shapes and contracts | Imported by 7 modules |
| `redaction.ts` | Redaction logic and helpers | Imported by 4 modules |
| `redaction.test.ts` | Unit tests for redaction | Imports 3 dependencies |

`types.ts` serves as the canonical contract layer. Other modules import evidence types from this file rather than defining local interfaces, which keeps evidence shapes consistent across the codebase and avoids drift between producers and consumers of evidence data.

The module depends on [`src/contracts`](src-contracts.md), aligning evidence definitions with the application's shared contracts.

## Key concepts

### Evidence identity

- **`EvidenceRecord`** — The primary record describing a piece of evidence: what it is, where it came from, and what it relates to.
- **`EvidenceKind`** — Classification or category for evidence, used to distinguish different flavors of recorded observations.
- **`EvidenceCausalIds`** — Identifiers linking a piece of evidence back to the events or actions that caused it.

### Provenance and artifacts

- **`EvidenceProvenance`** — Metadata describing where a piece of evidence originated (e.g. which process, run, or scan produced it).
- **`EvidenceArtifactRef`** — A reference to an artifact (file, output, etc.) related to a piece of evidence.

### Scanning

- **`ScanResult`** — The result data produced when evidence is passed through a scanning process.

### Redaction

- **`RedactionDeps`** — Dependencies or context required to perform redaction operations.
- **`RedactionResult`** — Output shape produced by a redaction operation, containing the sanitized evidence.
- **`RedactionProvenance`** — Metadata describing what redaction was applied and why.
- **`redactForPersistence`** — Helper function that transforms evidence into a form safe to persist to storage.

## Main flows

### Creating evidence records

1. A consumer module imports evidence types from `src/harness/evidence`.
2. It constructs an `EvidenceRecord`, classifying it with `EvidenceKind`.
3. It attaches provenance via `EvidenceProvenance`.
4. It references related artifacts using `EvidenceArtifactRef`.
5. It associates causal identifiers through `EvidenceCausalIds`.

### Redacting before persistence

Modules that need to sanitize evidence before storage follow this pattern:

1. Gather redaction context into `RedactionDeps`.
2. Call `redactForPersistence(evidence, deps)`.
3. Receive a `RedactionResult` containing the transformed evidence and an accompanying `RedactionProvenance` describing what was removed or altered.

### Sharing across modules

The centralized types enable consistent evidence exchange between:

- [`src/harness/child`](src-harness-child.md)
- [`src/harness/extension`](src-harness-extension.md)
- [`src/harness/flow`](src-harness-flow.md)
- [`src/harness/process`](src-harness-process.md)
- [`src/harness/run`](src-harness-run.md)
- [`src/security`](src-security.md)

Because all these modules speak the same evidence vocabulary, evidence produced in one part of the harness (e.g. during process execution) can be consumed, scanned, or redacted elsewhere without translation.

## Public API

| Symbol | Type | Description |
|--------|------|-------------|
| `EvidenceCausalIds` | interface | Identifiers for evidence causal relationships |
| `EvidenceArtifactRef` | interface | Reference to a related artifact |
| `EvidenceProvenance` | interface | Origin metadata for evidence |
| `EvidenceKind` | type | Evidence classification |
| `EvidenceRecord` | interface | Main evidence record shape |
| `ScanResult` | interface | Result of evidence scanning |
| `RedactionDeps` | interface | Dependencies for redaction |
| `RedactionResult` | type | Output of redaction operation |
| `RedactionProvenance` | interface | Metadata about applied redaction |
| `redactForPersistence` | function | Prepares evidence for safe storage |

## Dependents

This module is consumed by:

- `src/harness/child` — 2 imports
- `src/harness/extension` — 2 imports
- `src/security` — 2 imports
- `src/harness/flow` — 1 import
- `src/harness/process` — 1 import
- `src/harness/run` — 1 import

## Related Wiki

- [Wiki Index](../index.md)
- [Module src/contracts](src-contracts.md)
- [Module src/harness/child](src-harness-child.md)
- [Module src/harness/extension](src-harness-extension.md)
- [Module src/security](src-security.md)
- [Module src/harness/flow](src-harness-flow.md)
- [Module src/harness/process](src-harness-process.md)
- [Module src/harness/run](src-harness-run.md)

## Changelog

- 0.1.0 — Initial documentation generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z.
