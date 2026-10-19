---
Title: Module src/eval
Version: 1.0.0
Type: component
Status: accepted
Summary: "`src/eval` runs a detector over a labeled fixture corpus (`cases.json`) and reports false-negative rate, precision and recall. `gateCorpus` fails a report whose false-negative rate exceeds a configured maximum."
---

# Module src/eval

## Overview

`src/eval` is the fixture-corpus acceptance harness for detectors. A block names its corpus directory and supplies a `DetectorFn`; `runCorpus` scores that detector against the labeled cases in `cases.json` and returns a `CorpusReport`, and `gateCorpus` turns that report into a pass/fail decision against a maximum false-negative rate. The module contains no per-block code, so the same runner serves every detector.

**Primary consumer:** `src/security/detect`

**Collaborators:** `src/testing`, `fixtures/churn-complexity`, `src/health/metrics`

---

## How it works

The module has three layers over one data contract. The contract is `fixtures/<corpus>/cases.json`, either a bare array or `{ cases: [...] }`, where each entry carries a string `id`, a string `input`, and `expected` set to `"positive"` or `"negative"`.

The loader, `loadCorpusCases` in `src/eval/corpus.ts`, is the only code that validates this contract. It returns `[]` when the file is missing or cannot be parsed, silently drops malformed entries, and sorts the rest by `id` so every run visits cases in the same order.

The runner, `runCorpus`, scores each case by calling the detector with the raw `input` string and coercing its result to a boolean, then tallies true and false positives and negatives. It computes the rates in the same file, using 0 for any rate whose denominator is zero.

The gate, `gateCorpus` in `src/eval/gate.ts`, is a pure function over a finished report. It reads only `fnRate` and the configured `maxFnRate`, and it has no side effects.

## Key concepts

- **CorpusCase**: one labeled item, with `id`, `input` and `expected`.
- **DetectorFn**: `(input: string) => boolean | Promise<boolean>`. A detector receives only the input text, not the case, so it cannot see the case id or its label.
- **CorpusReport**: `corpus` (the directory basename), `total`, the four confusion counts (`truePos`, `falseNeg`, `falsePos`, `trueNeg`), and the rates `fnRate` (false negatives over all positives), `precision` (true positives over all flagged cases) and `recall` (true positives over all positives).
- **GateOptions / GateResult**: the input is `maxFnRate`; the output is `status` (`"pass"` or `"fail"`) plus a list of human-readable `reasons`.

## Main flows

1. **Scoring a corpus.** A caller invokes `runCorpus(dir, detect)` with a directory, not an array of cases. The loader reads `dir/cases.json`, normalizes it and sorts it by id. For each case the runner awaits `detect(input)`. A flagged positive counts as a true positive and an unflagged one as a false negative. A flagged negative counts as a false positive and an unflagged one as a true negative. The runner then returns the report. Because cases are sorted and the report is deterministic, re-running the same corpus with the same detector yields an identical report.

2. **Gating a report.** `gateCorpus(report, { maxFnRate })` checks whether `report.fnRate > maxFnRate`. If it is, the result is `fail` with one reason string that names the corpus, the rate, the maximum, and the count of false negatives out of positives. Otherwise the result is `pass` with no reasons. Only the false-negative rate is gated; precision and recall are reported but not checked.

3. **Empty or missing corpus.** If `cases.json` is missing, unparsable, or contains no valid entries, `runCorpus` returns `total` 0 with every rate at 0. Because `fnRate` is then 0, the gate passes. The gate therefore does not catch an empty corpus on its own.

---

## Public API

| Symbol | Type | Description |
|--------|------|-------------|
| `CorpusCase` | interface | A single evaluation item |
| `DetectorFn` | interface | A detector callable that can be evaluated against corpus cases |
| `CorpusReport` | interface | The outcome of a corpus evaluation run |
| `loadCorpusCases` | function | Prepares corpus cases for execution |
| `runCorpus` | function | Applies a detector to loaded cases and returns a report |

---

## Usage

### Evaluate a corpus

```typescript
import { loadCorpusCases, runCorpus, DetectorFn } from './eval';

// 1. Load corpus cases
const cases = await loadCorpusCases('path/to/fixtures');

// 2. Provide a detector implementation
const myDetector: DetectorFn = async (case) => {
  // detection logic
};

// 3. Execute the corpus
const report = await runCorpus(myDetector, cases);
```

### Run in tests

Test files in `src/eval/` use `src/testing` and fixture data to verify evaluation behavior:

- `src/eval/corpus.test.ts`
- `src/eval/block-d-corpora.test.ts`

---

## Key files

| File | Role |
|------|------|
| `src/eval/corpus.ts` | Core corpus loading and execution logic |
| `src/eval/gate.ts` | Reusable evaluation helper surface |
| `src/eval/corpus.test.ts` | Tests for corpus functionality |
| `src/eval/block-d-corpora.test.ts` | Tests using fixture-backed corpus data |

---

## Dependencies

- `src/testing` — 2 imports
- `fixtures/churn-complexity` — 1 import
- `src/health/metrics` — 1 import
- `src/health` — 1 import
- `src/lib` — 1 import

---

## Dependents

- `src/security/detect` — 2 imports (primary consumer)

---

## Related Pages

- [Wiki Index](../index.md)
- [Module src/testing](src-testing.md)
- [Module src/health/metrics](src-health-metrics.md)
- [Module src/health](src-health.md)
- [Module src/lib](src-lib.md)
- [Module src/security/detect](src-security-detect.md)

---

## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `CorpusCase`
- `DetectorFn`
- `CorpusReport`
- `loadCorpusCases`
- `runCorpus`

### Key files

- `src/eval/block-d-corpora.test.ts` - imported by 0, imports 7
- `src/eval/corpus.ts` - imported by 4, imports 1
- `src/eval/gate.ts` - imported by 3, imports 1
- `src/eval/corpus.test.ts` - imported by 0, imports 2

### Depends on

- `src/lib` - 1 import(s)

### Dependency basis

- Production imports only: 7 import(s) from test file(s) (e.g. `src/eval/block-d-corpora.test.ts`) excluded from the two sections above in both directions.

### Graph signals

- Files: 4
- Cross-module imports: 1

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked, other modules are named as code paths; when enriching, add
new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/lib](src-lib.md)

## Changelog

- 1.0.0 — Prose enriched from Key files by the gdwiki skill.
- 0.1.1 - Generated sections regenerated by `keryx wiki collect --force`; prose untouched.
- 0.1.0 — Generated by `keryx wiki collect` at 2026-09-16T16:24:12.891Z. Prose enriched and accepted.
