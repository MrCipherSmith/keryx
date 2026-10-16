# Paired evaluation preparation

Status: preparation only; no quality, latency or rollout result is recorded here.
The operator approved preparation without model calls. Model selection, external
transmission and spending require separate approval before execution.

## Dataset contract

Use consented synthetic sources only. Each query record must bind project,
session, split, source version/hash and exact relevant spans. Keep development
and held-out projects AND sessions disjoint. Freeze the held-out labels before
tuning. A small fixture suite is a smoke test, not adequate quality evidence.

Required strata: answerable, unanswerable, conflicting, paraphrased,
current-visible and compacted-out. Include rewritten/deleted/revoked sources,
cross-project distractors and instruction-shaped untrusted text. Labels distinguish
relevant evidence from evidence eligible for delivery; visible exact evidence
must not count as a retrieval miss when correctly excluded.

## Execution contract for the future CI runner

Compare A accepted-memory tools; B lexical; C hybrid; D hybrid plus exact
visibility; E D plus incremental indexing. Record A's narrower coverage separately.
Use identical queries, seeds, eligible source scope and request budgets for B–E.
Pin dataset/query/config/model/tokenizer/chunker revisions, runtime and hardware.
Record actual serialized request hashes, not an inferred visibility manifest.
Perform at least three timing repetitions; count build and query embeddings
separately. Exercise unchanged and appended builds, and crash recovery.

Emit per-query rankings, source/version/span labels, named failures, grounded
answers and blinded answer IDs. Score Recall@10, MRR, source precision, duplicate
tokens, false absence/exclusion, p50/p95 latency, embedding calls/tokens, bytes
read/indexed and recovery time. Report paired bootstrap confidence intervals over
queries with fixed resampling seed. Grounded-answer review must be blind to arm.
Missing observations remain missing: never replace them with zero or fixture PASS.

## Approval gates

Before a CI run, approve models, consent/network path, spending ceiling and
reviewer; decide held-out sample size and practical quality thresholds in advance.
Hard-zero safety gates from metrics-and-validation.md remain mandatory. Publish
commands, commit SHA, hashes, raw observations, uncertainty and unsupported
adapters. An inconclusive report keeps hybrid/automatic optional; only the
operator decides rollout. This document does not complete T12.

## Starter dataset

`paired-evaluation-starter.json` contains synthetic source text and query labels.
It is an exploratory smoke corpus, NOT the frozen quality-evaluation holdout.
Each relevant span is the unique exact `quote` in its source; a future runner must
resolve offsets and hash source bytes before running, refusing ambiguous labels.
Lifecycle and visibility fields describe scenarios the runner must instantiate,
not observations or completed checks. Instantiate source mutations, revocation
and exact outgoing-request visibility before scoring eligibility. Refuse a
scenario the runner cannot reproduce; do not silently treat it as a static query.

## Offline preparation command

```sh
bun scripts/benchmark/prepare-evidence-evaluation.ts docs/requirements/keryx-evidence-retrieval/paired-evaluation-starter.json > /tmp/evidence-preparation.json
```

The preparer validates IDs, split separation, eligible labels, unique quotes and
lifecycle prerequisites. It resolves half-open UTF-8 byte offsets and SHA-256
hashes without importing the retrieval runtime or loading models. Malformed
input exits nonzero without echoing source text. The output is deterministic for
identical dataset bytes; changing formatting changes the dataset hash.

This manifest is not an evaluation report: arms, scenarios and visibility proofs
remain `not-run`; metrics and rollout decision remain null. `missingCoverage`
explicitly flags the starter's absent deleted-source fixture. It does not certify
complete protocol coverage. Input must already be approved synthetic data: the
declaration is not consent verification. Manifests retain IDs, projects and
sessions; hashes do not anonymize them. Tests are picked up by CI's AC8 full suite.

## Offline scoring helpers

`scripts/benchmark/evidence-evaluation-metrics.ts` scores supplied observations;
it does not run retrieval or establish eligibility. The runner must resolve exact
visibility and source eligibility before supplying labels. Recall@10 requires a
single ranked span to contain the complete label with matching source/version/hash.
MRR uses the full supplied ranking; source precision uses unique versioned sources
in the first ten results. Unanswerable recall/MRR and missing observations are null.
Paired bootstrap resamples complete query pairs (fixed seed, percentile 95% CI),
reports missing pairs, and withholds CI for fewer than two pairs. Latency uses
nearest-rank p50/p95. These helpers alone are not a report or a rollout gate.


## Offline orchestration runner

`run-evidence-evaluation.ts` exports an adapter-driven runner for A–E, three
repetitions, split-separated paired scoring and content-free named failures.
Repetitions are averaged per query before bootstrap; incomplete triples stay
missing. Missing adapters never become zero. Source/version/hash/project/split,
active state and span bounds are checked before scoring. Adapter exceptions are
not serialized. Adapters are trusted caller-supplied code; the harness neither
certifies their execution provenance nor grants network/model authorization.

The CLI accepts the same dataset path as the preparer and intentionally loads no
adapters. Its output contains missing observations, not retrieval measurements.
Tests inject fixture adapters only. No production A–E adapters are wired yet.
Lifecycle and visibility classes remain explicitly unsupported until a driver
can produce actual mutation/final-request proofs; they are not static queries.
Grounded-answer judgments, embedding accounting, duplicate-token, recovery and
full ranking artifacts remain future work. This runner is partial infrastructure,
not the full protocol implementation, a quality report or a completed T12.

Per-observation deadlines default to 30 seconds (configurable 1–300000 ms).
Expiry requests cooperative cancellation and prevents further adapter calls;
subsequent observations stay cancelled/missing. It cannot terminate arbitrary
in-process code or CPU loops; untrusted adapters need process isolation.
Query splits are restricted to dev/held-out; distractor is source-only.


### Production lexical smoke adapter (B only)

`bun scripts/benchmark/run-evidence-evaluation.ts docs/requirements/keryx-evidence-retrieval/paired-evaluation-starter.json --lexical`

This opt-in command builds isolated temporary projects from active synthetic files,
partitioned by project and split. It uses the production scanner, lifecycle-backed
index build, and validated lexical search; no embedding, API or model is loaded.
Source identifiers are mapped through generated ordinal filenames, not used as paths.
Temporary projects and runtime handles are removed in `finally`.

Only static answerable, unanswerable, conflicting, paraphrased and instruction-shaped
queries are eligible. Revocation, rewrite, current-visible and compacted-out scenarios
remain unsupported: selecting active files is **not** proof of a lifecycle transition.
A/C/D/E remain missing. Scanner-modified envelopes fail closed rather than receiving
credit for every original byte. Unsupported/failing observations are not quality zeros.

Timing includes search validation and scanning but excludes corpus creation/build;
the three sequential repetitions have no explicit warmup and are not independent pairs.
The execution metadata labels these limitations. This remains exploratory smoke
execution, not a frozen holdout, full A–E evaluation, or rollout approval.
