---
Title: Module src/security/detect/pii
Version: 1.0.0
Type: component
Status: accepted
Summary: `src/security/detect/pii` groups 2 file(s). Depends on `src/capability`, `src/security`, `src/security/detect`. Exposes 7 public symbol(s).
---

# Module src/security/detect/pii

## Overview

`src/security/detect/pii` implements an optional Named-Entity Recognition (NER) adapter that adds a model-backed PII detection ceiling on top of the deterministic PII detectors in the parent `src/security/detect` module. It exposes a `CapabilitySpec` registered under the id `security.piiNer` and loaded lazily through the capability seam—the NER runtime is never statically imported, ensuring zero overhead when the model is absent. When the runtime and its pinned model asset are both available, the adapter merges recognized person, location, and organization spans into the shared `DetectorMatch` stream. When either is missing, the system degrades silently to the byte-identical deterministic floor.

## How it works

The single source file `ner-adapter.ts` is structured in three layers:

- **Outermost layer (public factory surface):** `makeNerSpec` builds a `CapabilitySpec<string, DetectorMatch[]>` by closing over optional configuration (an npm dependency name, a model-asset id, and an injectable `NerRecognizer` for testing). `piiNerSpec` is a thin convenience wrapper that binds a runtime package and a pinned asset id.

- **Middle layer (CapabilityAdapter):** Returned by `makeNerSpec`’s `load()` callback. `isAvailable()` checks that both optional dependency and optional asset resolved without errors. `run(content)` dispatches to either the injected recognizer or the private `runRuntimeRecognizer` bridge.

- **Innermost layer (runtime bridge):** `runRuntimeRecognizer` is a structural duck-type bridge that calls the runtime’s `pipeline("token-classification", model)` without ever importing the package by name. It converts raw token-classification rows into typed `NerEntity` objects. The conversion step—`nerMatchesFrom`—maps each entity to a `DetectorMatch` with `category: "pii"` and a safe, fixed-width mask: location and geo-political labels become `"address"`, everything else (person, org) becomes `"name"`. Any error in the adapter is caught by the capability seam and causes a graceful fallback to the synchronous deterministic detectors, with a one-time warning emitted via `warn-once`.

## Key concepts

- **NerEntity** — A span produced by the NER runtime: character offsets `start`/`end`, the matched `value`, a `label` (e.g. `PERSON`, `LOCATION`, `ORG`), and an optional confidence `score`. Internal currency between the runtime bridge and the match converter.

- **NerRecognizer** — A callable `(text: string) => NerEntity[] | Promise<NerEntity[]>`. Exists to make the adapter testable with a deterministic, seeded function without requiring a real model download.

- **CapabilitySpec / CapabilityAdapter** — Abstractions from `src/capability/seam`. A `CapabilitySpec` declares optional dependencies and assets needed; the seam resolves them and calls `load()` to produce the `CapabilityAdapter`. The adapter exposes `isAvailable()` and `run()`. This indirection keeps the NER runtime out of the static import graph.

- **Ceiling vs. floor** — The NER adapter adds findings on top of the deterministic detectors, never replacing them. When the ceiling is unavailable, the output is byte-identical to the deterministic floor.

- **Fixed-width mask** — `nerMatchesFrom` assigns every entity a safe, opaque replacement token (`"name"` or `"address"`) rather than preserving any part of the original text, satisfying the leak-safe redaction policy (E-9).

- **warn-once** — A lightweight deduplication guard (`src/capability/warn-once`) that logs a single warning per capability id across the process lifetime, preventing log spam when the NER backend is consistently unavailable.

## Main flows

**Flow 1 — NER backend available (happy path).** The caller invokes `runDetectorsAsync` (in `src/security/detect/index`) with a `piiNer` spec built by `makeNerSpec` or `piiNerSpec`. The capability seam resolves the optional runtime dependency and model asset, calls `makeNerSpec`’s `load()`, and checks `isAvailable()`—both preconditions are met. `run(content)` is called: if no injectable recognizer is set, `runRuntimeRecognizer` lazily calls `dep.pipeline("token-classification", asset.path)`, invokes the resulting pipeline on the input text, and parses the rows into `NerEntity[]`. `nerMatchesFrom` converts those entities to `DetectorMatch[]` with `category:"pii"` and the appropriate `"name"` or `"address"` mask. These findings are merged with the synchronous deterministic results and returned to the caller.

**Flow 2 — NER backend unavailable (graceful degradation).** The seam resolves the optional dependency or asset to `null`/`undefined`. `isAvailable()` returns `false`. The seam skips `run()` entirely, emits a single `warn-once` warning for `PII_NER_ID`, and returns only the synchronous deterministic PII matches—byte-identical to a run without any NER spec. The caller cannot distinguish this from the no-model case.

**Flow 3 — Testing with an injectable recognizer.** A test calls `makeNerSpec({ recognizer: seededRecognizer })` with a deterministic function instead of an npm package. The seam calls `load()`, `isAvailable()` returns `true` (no `optionalDependency` or `asset` was declared), and `run(content)` dispatches directly to `seededRecognizer`. The returned `NerEntity[]` flows through `nerMatchesFrom` and merges with the synchronous detectors, allowing the full merge path to be exercised in an offline environment with no model download.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by `--force`. The prose sections above are the agent/human-owned part.

### Public API

- `PII_NER_ID`
- `NerEntity` (interface)
- `NerRecognizer` (interface)
- `nerMatchesFrom` (function)
- `MakeNerSpecOptions` (interface)
- `makeNerSpec` (function)
- `piiNerSpec` (function)

### Key files

- `src/security/detect/pii/ner-adapter.test.ts` - imported by 0, imports 4
- `src/security/detect/pii/ner-adapter.ts` - imported by 2, imports 0

### Depends on

- `src/capability` - 1 import(s)
- `src/security` - 1 import(s)
- `src/security/detect` - 1 import(s)

### Depended on by

- `src/security/detect` - 1 import(s)

### Graph signals

- Files: 2
- Cross-module imports: 3

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/capability](src-capability.md)
- [Module src/security](src-security.md)
- [Module src/security/detect](src-security-detect.md)

## Changelog

- 1.0.0 - Prose enriched by gdwiki enrich workflow: Overview, How it works, Key concepts, Main flows written from code reads of `ner-adapter.ts` and `ner-adapter.test.ts`. Status promoted to accepted.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
