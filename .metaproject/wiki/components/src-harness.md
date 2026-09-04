---
Title: Module src/harness
Version: 1.0.1
Type: component
Status: accepted
VerifiedAt: 5886c474beb774901805417efb1cc4d1a03935df
VerifiedScope: sha256:addfd1ceb6a0fe385058f24b228b593d8ea5499f3ed59168f1e16c8aeea60da5
Summary: `src/harness` groups 4 file(s). Depends on `fixtures/churn-complexity`, `src/health/metrics`, `src/health`. Exposes 5 public symbol(s).
---

# Module src/harness

## Summary

`src/harness` groups 4 file(s). Depends on `fixtures/churn-complexity`, `src/health/metrics`, `src/health`. Exposes 5 public symbol(s).

## Overview

`src/harness` is a fixture-corpora acceptance harness: a shared, detector-agnostic runner that validates quality against labeled data rather than asserted prose. It loads a committed `cases.json` file from any named corpus directory, runs a caller-supplied `DetectorFn` over each labeled case, and computes a deterministic `CorpusReport` of precision, recall, and false-negative rate. A thin gate layer (`gate.ts`) converts that report into a CI pass/fail signal by comparing the false-negative rate against a configurable threshold.

## How it works

`corpus.ts` owns the full runner logic. `loadCorpusCases` reads and normalises a `cases.json` file from a given directory — it accepts either a bare JSON array or a `{ cases: [...] }` envelope, drops malformed entries, and sorts survivors by `id` to guarantee a stable, re‑runnable output. `runCorpus` calls `loadCorpusCases`, iterates every case through the caller-supplied `DetectorFn` (which may be sync or async), accumulates true/false positive/negative counts, and derives `fnRate`, `precision`, and `recall` from those counts, guarding against division by zero throughout.

`gate.ts` is intentionally minimal: `gateCorpus` receives a finished `CorpusReport` and a `maxFnRate` threshold and returns a `GateResult` of `"pass"` or `"fail"` with a human-readable reason string. The gate owns no I/O and no detection logic — it is a pure decision boundary on top of the report.

This two-layer split means any detection block anywhere in the codebase can plug into the same harness by pointing `runCorpus` at its corpus directory and passing its detector function, with no per-block harness code required.

## Key concepts

- **Corpus**: a named directory of labeled test cases committed alongside fixtures. Each corpus is identified by its directory name (returned as `CorpusReport.corpus`). The module ships two seed corpora (`seed-secrets`, `seed-emails`) and Block D adds `churn-complexity` and `change-impacted-test`.
- **CorpusCase**: a single labeled data point with an `id`, a raw `input` string, and an `expected` label of `"positive"` or `"negative"`.
- **DetectorFn**: the interface that every detection block must satisfy — a function from a raw input string to a boolean (sync or async). The harness is agnostic to what the detector actually does.
- **CorpusReport**: the deterministic output of `runCorpus` — counts of true/false positives and negatives plus derived rates (`fnRate`, `precision`, `recall`). Determinism is enforced by sorting cases by `id` before execution.
- **GateResult**: the CI signal from `gateCorpus` — `"pass"` or `"fail"` with a list of human-readable `reasons`. A `fail` result is intended to produce a non-zero exit code in CI.
- **False-negative rate (fnRate)**: the primary gate metric. A regression in recall (missing a positive) is treated as more dangerous than a false alarm, so the gate threshold is expressed exclusively in terms of `fnRate`.

## Main flows

**1. Seed-corpus acceptance run (corpus.test.ts)**  
A test calls `runCorpus(path.join(FIXTURES, "seed-secrets"), secretDetector)`. `corpus.ts` reads `fixtures/seed-secrets/cases.json`, normalises and sorts the six labeled cases, runs each through the regex‑based `secretDetector`, and returns a `CorpusReport` with `total=6`, `fnRate=0`, `precision=1`, `recall=1`. A second test repeats the same call and asserts that `JSON.stringify` of both results is identical — proving the determinism guarantee.

**2. CI gate evaluation (corpus.test.ts → gate.ts)**  
After `runCorpus` returns a report, the test calls `gateCorpus(report, { maxFnRate: 0.1 })`. `gate.ts` compares `report.fnRate` against `0.1`; because the seed detector is perfect, `reasons` is empty and `status` is `"pass"`. A second call with a deliberately lossy detector produces `fnRate ≈ 0.667`, which exceeds the threshold, so `gate.ts` appends a reason string and returns `status: "fail"`.

**3. Block D capability acceptance (block-d-corpora.test.ts)**  
A more complex consumer builds a real detector for hotspot ranking (`rankHotspots` from `src/health/metrics`) and passes it as a `DetectorFn` to `runCorpus` against the `fixtures/churn-complexity` corpus. The harness runs without any block-specific code — the caller provides the detector and the corpus directory; `corpus.ts` handles loading and scoring. The resulting report is then fed into `gateCorpus` with `maxFnRate: 0`, confirming zero false negatives as the hard acceptance criterion (AC17).

---

<!-- keryx:reference:begin v=1 hash=33427cad981a3f40ae579cea7b8958acadbb511c583ae658b01f3a420a648537 -->
## Reference (from code graph)

Extracted deterministically by `keryx wiki collect`; regenerated by
`--force`. The prose sections above are the agent/human-owned part.

### Public API

- `HarnessLimits` (interface)
- `HarnessNetworkPolicy` (interface)
- `HarnessConfig` (interface)
- `HarnessRole`
- `HarnessTransport`
- `HarnessBudget` (interface)
- `HarnessScope` (interface)
- `HarnessRunInput` (interface)

### Key files

- `src/harness/config.ts` - imported by 17, imports 0
- `src/harness/types.ts` - imported by 17, imports 0
- `src/harness/run-external-factory.ts` - imported by 4, imports 11
- `src/harness/rpc.test.ts` - imported by 0, imports 12
- `src/harness/rpc.ts` - imported by 2, imports 3
- `src/harness/run-external-factory.test.ts` - imported by 0, imports 5

### Depends on

- `src/harness/external` - 11 import(s)
- `src/harness/child` - 4 import(s)
- `src/harness/session` - 3 import(s)
- `src/harness/provider` - 3 import(s)
- `src/harness/run` - 3 import(s)
- `src/harness/tool` - 3 import(s)

### Depended on by

- `src/harness/run` - 11 import(s)
- `src/commands` - 7 import(s)
- `src/harness/replay` - 4 import(s)
- `src/harness/resume` - 4 import(s)
- `src/lib` - 4 import(s)
- `src/tui` - 2 import(s)

### Graph signals

- Files: 13
- Cross-module imports: 40
<!-- keryx:reference:end -->

## Related Wiki

Graph-derived - regenerated by `keryx wiki collect --force`. Only pages that
exist are linked; when enriching, add new links only to pages you have verified.

- [Wiki Index](../index.md)
- [Module src/health/metrics](src-health-metrics.md)
- [Module src/health](src-health.md)
- [Module src/testing](src-testing.md)
- [Module src/lib](src-lib.md)
- [Module src/security/detect](src-security-detect.md)

## Changelog

- 1.0.1 - Reference refreshed from the code graph (5886c474).
- 1.0.0 - Prose enriched by gdwiki enrich workflow: Overview, How it works, Key concepts, Main flows grounded in corpus.ts and gate.ts.
- 0.1.0 - Generated by `keryx wiki collect` at 2026-07-10T08:14:04.890Z. Prose sections are drafts for the gdwiki enrich workflow.
