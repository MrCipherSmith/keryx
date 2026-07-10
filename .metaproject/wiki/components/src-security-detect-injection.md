# Module src/security/detect/injection

Version: 1.0.0
Type: component
Status: accepted

## Summary

`src/security/detect/injection` groups 2 file(s). Depends on `src/security`, `src/security/detect`, `src/capability`. Exposes 7 public symbol(s).

## Overview

`src/security/detect/injection` implements an optional semantic-model layer that sits on top of the always-on regex injection detector. It exposes a `CapabilitySpec` (Block E/E1) that the security seam resolves at runtime: when both the text-classification runtime dependency and a verified model asset are present, the adapter runs a Prompt Guard 2 classifier and adds recall for paraphrased injections that the regex floor misses. When either prerequisite is absent the module degrades silently to regex-only detection, preserving exit-0 semantics and byte-identical output.

## How it works

The module is a single file (`adapter.ts`) structured around the `CapabilitySpec` contract from `src/capability/seam`. `makeInjectionSpec` constructs the spec: it declares an optional runtime dependency and an optional verified asset path, and returns a `load()` factory that the seam calls once both are resolved. The resulting `CapabilityAdapter` exposes `isAvailable()` — which returns `true` only when both the runtime dep and the asset resolved — and `run(content)`, which calls the classifier and forwards the raw score to `injectionMatchesFromScore`.

Score normalization is handled by `injectionScoreOf`, which accepts the common `[{ label, score }]` shape returned by transformer-style text-classification pipelines. It maps INJECTION/JAILBREAK/LABEL_1 labels to their raw score and BENIGN/LABEL_0 labels to the complement (`1 - score`), taking the max across all rows. This keeps the module structurally decoupled from any particular ML library — `runRuntimeClassifier` bridges to the runtime via a duck-typed `pipeline()` call and never imports the package statically.

Tests in `adapter.test.ts` inject a deterministic `seededClassifier` function to verify the merge-and-recall path without requiring a real model download. The metaproject manifest controls capability enablement via a `capabilities` entry keyed on `INJECTION_MODEL_ID`.

## Key concepts

- **CapabilitySpec / CapabilityAdapter** — the seam contract from `src/capability` that allows optional runtime dependencies. A spec declares what it needs (dependency id, asset id); the seam resolves both and calls `load()`. The adapter's `isAvailable()` gate determines whether detection actually runs.
- **INJECTION_MODEL_ID** — the string key (`"security.injectionModel"`) used to register and look up this capability in the metaproject manifest and the security config.
- **InjectionClassifier** — a simple callable `(text: string) => Promise<number> | number` that returns an injection probability in [0, 1]. The interface is injectable so tests can substitute a deterministic classifier without model weights.
- **minConfidence threshold** — a configurable floor (default 0.5) below which classifier scores produce no findings. This prevents low-confidence model noise from escalating to approval-required decisions.
- **Regex floor** — the deterministic `detectInjection` detector in `src/security/detect/injection` (the parent module) that always runs. This adapter never replaces it; it only supplements with additional recall.
- **Degradation / warn-once** — when `isAvailable()` returns false (missing dep or unverified asset), the seam logs a one-time warning via `warn-once` and returns regex-only results that are byte-identical to the synchronous path.

## Main flows

**Flow 1 — Happy path (model available, paraphrase detected)**
`runDetectorsAsync` is called with content and a resolved `SecurityConfig`. The seam resolves the spec built by `injectionModelSpec` (runtime dep + asset both present). `CapabilityAdapter.isAvailable()` returns `true`. `run(content)` calls `runRuntimeClassifier`, which duck-types the runtime's `pipeline("text-classification", asset.path)` and obtains a `[{ label, score }]` result. `injectionScoreOf` normalises the result to a probability. If the score meets `minConfidence`, `injectionMatchesFromScore` emits a `DetectorMatch` with `category:"prompt-injection"` and `policyId:"prompt-injection.model"`. The match is merged with regex findings and passed to `resolveDecision` in `src/security/resolve`, which may escalate to `require-approval` when a co-occurring egress signal is present (AC1.4).

**Flow 2 — Degradation (asset missing or dep unresolved)**
The seam resolves the spec but either the optional dependency or the asset is absent. `isAvailable()` returns `false`. The seam emits a one-time warning via `warn-once` keyed on `INJECTION_MODEL_ID` and skips `run()`. `runDetectorsAsync` returns the same matches as the synchronous `runDetectors`, byte-identical to the regex-only baseline (AC1.3). The process exits 0 with no model findings in the output.

**Flow 3 — Test / offline path (injected classifier)**
`makeInjectionSpec` is called with a `classifier` option pointing to a deterministic function (e.g. `seededClassifier`). The seam calls `load()` and wires `run()` to call the injected classifier directly, bypassing `runRuntimeClassifier`. Availability still follows the dep/asset resolution logic. This lets `adapter.test.ts` assert recall improvement over the regex baseline and confirm escalation behaviour without downloading any model weights.

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `INJECTION_MODEL_ID`
- `InjectionClassifier` (interface)
- `MakeInjectionSpecOptions` (interface)
- `injectionMatchesFromScore` (function)
- `makeInjectionSpec` (function)
- `injectionModelSpec` (function)
- `injectionScoreOf` (function)

### Key files

- `src/security/detect/injection/adapter.test.ts` - imported by 0, imports 6
- `src/security/detect/injection/adapter.ts` - imported by 2, imports 0

### Depends on

- `src/security` - 2 import(s)
- `src/security/detect` - 2 import(s)
- `src/capability` - 1 import(s)

### Depended on by

- `src/security/detect` - 1 import(s)

### Graph signals

- Files: 2
- Cross-module imports: 5

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/security](src-security.md)
- [Module src/security/detect](src-security-detect.md)
- [Module src/capability](src-capability.md)

## Changelog

- 1.0.0 - Prose enriched by gdwiki enrich workflow. Overview, How it works, Key concepts, and Main flows filled from `adapter.ts` and `adapter.test.ts`.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
