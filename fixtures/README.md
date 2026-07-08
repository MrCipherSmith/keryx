# Fixture Corpora

Committed, deterministic labeled corpora consumed by the shared fixture-corpora
harness (`src/harness/corpus.ts`). Each corpus lives in its own directory with a
`cases.json` file of labeled cases:

```json
{ "cases": [ { "id": "…", "input": "…", "expected": "positive" | "negative" } ] }
```

A block names its corpus directory as its acceptance gate; the harness runs any
corpus through the same `runCorpus(dir, detect)` runner with no per-block code
(specification.md §9, `F-1`/`F-2`). The seed corpora here (`seed-secrets`,
`seed-emails`) exercise the harness itself — they are not shipped detectors.
