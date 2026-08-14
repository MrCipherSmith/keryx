# Keryx Benchmark Suite — Metrics and Validation
Version: 0.1.0

Metrics are defined **per ladder**. They are never combined into a single score.
Every metric carries a reliability level, and any value that was not directly
measured is labeled, not invented.

## Reliability levels

Each numeric value is tagged:

- **exact** — measured directly (token counts from the provider, git-derived gold,
  coverage-derived impact).
- **estimated** — derived by a stated formula from measured inputs (e.g. cost from
  tokens × published price); the formula is recorded.
- **unknown** — not available for this target/run. Rendered as `unknown`, never `0`.

A report that shows a number without a level is invalid.

## Cross-model comparability

Raw output-token counts are **not comparable across models**: tokenizers differ
(a generation or vendor change can tokenize identical content ~30% higher). Any
cross-model token or cost comparison must therefore be reported **tokenizer-normalized**
— as word-level counts, or corrected by the target's published tokenizer ratio —
and the raw token-level number kept alongside, labeled. A comparison that pits raw
token counts from different tokenizers against each other is invalid.

The evidence bundle records the **actually-served model** and the **reasoning
effort / config**, not only the requested model: automatic model fallback or an
effort default can silently change what produced a result, and a comparative number
computed across mixed served-models or mixed effort is confounded and non-publishable.

## Metastore ladder

### Oracle / IR metrics (agent-free, deterministic, ×1)

| Layer | Command under test | Gold source | Metrics |
|-------|--------------------|-------------|---------|
| gdgraph (co-change prediction) | `gdgraph affected <target>` | git history (real co-change set), `goldAffectedSet` | precision, recall, F1 |
| gdgraph (graph correctness) | `gdgraph affected <target>` | independent transitive import closure, `goldDependencyClosure` | precision, recall, F1 |
| gdwiki | `wiki ask <q>` | curated Q→passage | nDCG, recall@k, groundedness |
| testing | `test related <file>` / TIA | coverage-derived impacted tests, `goldTestImpact` | precision, recall, F1 |
| memory | `memory search <q>` | curated applicable-decision | recall@k (plus precision, recall) |
| gdctx | compaction of a known output | the raw output's facts | fact-preservation rate |

**gdgraph is scored against two independent golds, reported separately and never
averaged** (`keryx metrics benchmark run --ladder metastore --gold co-change|dependency|all`,
default `all`; scorer: `src/metrics/oracle-runner.ts`, `buildOracleManifestsByGold`):

- **co-change prediction** — does gdgraph's dependency-based affected set predict the
  files that *really change together* with the target (git co-change gold,
  `goldAffectedSet`). A low F1 here is expected and does not by itself indict the graph:
  it measures a *prediction* across two different notions of "affected".
- **graph correctness** — does the affected set match the independent transitive import
  closure (`goldDependencyClosure`, built by `scripts/benchmark/parse-imports.ts`, which
  never calls gdgraph, so the comparison is not circular).

**Depth semantics (honest, not hidden).** `gdgraph affected` is **one-hop**: its forward
`dependencies` are structurally one-hop (`src/gdgraph/affected.ts`) and the committed
`gdgraph-affected.json` fixture uses depth=1 dependents, while the dependency gold is the
**full transitive** import closure. That forward gap cannot be closed (gdgraph cannot emit
a transitive forward closure), so the two numbers are reported **with an explicit
`depthSemantics` note** on every dependency-gold oracle metric rather than a silently
misleading score: **precision** = graph-edge correctness (are gdgraph's edges real closure
members), **recall** = one-hop coverage of the transitive closure (a lower bound, not a
defect rate). A fully depth-aligned score would require gdgraph to emit a transitive
forward closure, or scoring against a `maxDepth: 1` closure
(`goldDependencyClosure({ maxDepth: 1 })`).

**Testing / TIA oracle** (`keryx metrics benchmark run --ladder metastore --layer testing`;
scorer: `src/metrics/oracle-runner.ts`, `buildTestImpactManifest`). Scores the **system
test-impact set** — the test ids `keryx test related <file>` (naming + import-graph
heuristic, `src/testing/service.ts`) or the coverage-map TIA emit for a changed file — against
the **gold impacted-test set** derived from a REAL coverage map via `goldTestImpact`
(`src/metrics/gold.ts`: a test is gold-impacted iff its covered-files set intersects the
changed files). Metrics: precision, recall, F1, reliability `exact` (coverage-derived impact
is measured directly). It is a SEPARATE oracle from the gdgraph one (task-id namespace
`metastore:test-impact:*`) and is never averaged with it.

*How the coverage gold is produced (dogfood, no external clone).* `scripts/benchmark/run-testing-oracle.ts`
takes a small bounded keryx slice (`src/metrics/{benchmark,gold,ir,oracle-runner}.ts` and the
tests that exercise them), runs `bun test <testfile> --coverage --coverage-reporter=lcov` once
per slice test file, parses the lcov `SF:` records, and keeps only covered source files inside
the slice — yielding a real `testId → coveredFiles[]` map committed to
`fixtures/benchmark/keryx/coverage-map.json`. The system output
(`fixtures/benchmark/keryx/test-related.json`) is captured from `keryx test related` after
`keryx test analyze`. Regenerate both with `bun scripts/benchmark/run-testing-oracle.ts`
(then `git checkout -- .metaproject/data` to drop the analyze side-effect). Real committed
result: **precision 1.0** on all four targets (every heuristic-selected test really does
exercise the changed file), **recall** `gold.ts` 1.0, `oracle-runner.ts` 1.0, `benchmark.ts`
0.5, `ir.ts` 0.5 — the naming/import heuristic misses tests that exercise a file only
*transitively* (e.g. via a re-export or an intermediate import), an honest recall gap.

**Memory oracle** (`keryx metrics benchmark run --ladder metastore --layer memory`; scorer:
`src/metrics/oracle-runner.ts`, `buildMemorySearchManifest`). Scores the **system ranked
memory-id list** — the `path`s `keryx memory search <query> --json` returns, best match
first — against a **curated gold set** of relevant memory ids for that query
(`fixtures/benchmark/keryx/memory-gold.json`, hand-labeled offline: a query is included only
when the relevant entry is an OBVIOUS match, one line of justification each; k=3). Metrics:
**recall@k** (`src/metrics/ir.ts` `recallAtK`, the row's headline metric), plus unranked
precision/recall over the full retrieved set (same `scoreOracleTarget` set-arithmetic the
other two oracles use). Reliability `exact` — a hand-curated per-query relevance label is a
direct measurement, not a formula. It is a SEPARATE oracle (task-id namespace
`metastore:memory-search:*`) and is never averaged with the gdgraph or testing oracles.

*How the gold and system output are produced (dogfood, no external clone).*
`scripts/benchmark/run-memory-oracle.ts` reads the curated gold queries from
`memory-gold.json` (never regenerates the gold itself), runs `keryx memory search <query>
--json --limit 10` for each — this repo's own `.metaproject/memory/` corpus, no
`keryx memory index`/`analyze` side effect required, since search scans canonical Markdown
directly — and commits the captured ranked lists to
`fixtures/benchmark/keryx/memory-search-results.json`. Regenerate with
`bun scripts/benchmark/run-memory-oracle.ts`. Real committed result over the 5 curated
queries (k=3): **recall@k 1.0 on all five** (the gold entry is always found within the top 3
results — every query was built as a close paraphrase of its target entry's own title), with
unranked precision `0.2`–`1.0` (a query that matches only its gold entry's vocabulary scores
precision 1.0; a query whose terms also lexically overlap other entries' titles/tags pulls in
spurious top-10 hits, which recall@k with a small k is robust to but full-list precision is
not) — see `fixtures/benchmark/keryx/{memory-gold,memory-search-results}.json` for the
per-query breakdown.

**gdctx fact-preservation oracle** (`keryx metrics benchmark run --ladder metastore --layer
gdctx`; scorer: `src/metrics/oracle-runner.ts`, `buildGdctxManifest`). Scores a gdctx
**COMPACT form** — the summary `keryx ctx run -- <command>` prints — against the **FACTS
extracted from the RAW output it compacted**, via `factPreservation` (`src/metrics/ir.ts`):
what fraction of the raw output's discrete, verifiable facts survive into the compact form.
This is a lossless-fidelity check on gdctx itself: compaction is allowed to drop volume,
never to drop a fact a faithful reader would need. Metric: **fact-preservation rate**
(plus a Wilson-CI'd `rates.factPreservation` when the raw-facts denominator is non-empty).
Reliability `exact` — both sides are extracted from real, captured text by a fixed rule, not
estimated. It is a SEPARATE oracle (task-id namespace `metastore:gdctx-fact-preservation:*`)
and is never averaged with the gdgraph, testing, or memory oracles.

*Fact-extraction rule (fixed, reproducible, never hand-tuned per case — `extractFacts`,
`src/metrics/oracle-runner.ts`).* The SAME pass runs over the RAW command output and over the
gdctx COMPACT text. A FACT is one line, trimmed, that is either **(a)** a bare relative
file-path token — the whole trimmed line (or any individual whitespace-delimited token on the
line, once surrounding punctuation is stripped) matches `/^[\w.][\w./-]*\.[A-Za-z0-9]+$/`
(starts with a word character or a leading dot — so keryx's own dotdir tree, e.g.
`.metaproject/skills/catalog.md`, counts — and ends in a `.<extension>`), e.g.
`src/metrics/ir.ts`; or **(b)** a `key: value` metadata/count line — the whole trimmed line
matches `/^([A-Za-z][\w -]*):\s*`?(-?\d+)`?\s*$/`, normalized to `"<lowercased key>:<value>"`
so a fact re-wrapped in backticks by the compactor still normalizes identically (`"Exit code:
0"` and `` "Raw lines: `18`" `` both count). Facts are deduped as a set; extra facts present
only in the compact form (e.g. its own `Exit code:`/`Raw lines:` header) never affect the
score — `factPreservation` only counts RAW facts recovered in the compact set.

*How the fixture is produced (dogfood, no external clone, real compaction).*
`scripts/benchmark/run-gdctx-oracle.ts` runs `keryx ctx run -- <command>` for real on three
pinned `find <dir> -type f | sort` listings inside this repo, reads the raw log gdctx wrote
alongside the compact summary, extracts facts from both with `extractFacts`, and commits the
raw/compact fact sets to `fixtures/benchmark/keryx/gdctx-fact-preservation.json`. Regenerate
with `bun scripts/benchmark/run-gdctx-oracle.ts`. Real committed result over the 3 dogfood
inputs: **`find src/metrics -type f`: 1.0** (18/18 — short enough that gdctx's 120-line
compaction budget never truncates it, so nothing is lost); **`find .metaproject/skills -type
f`: ~0.697** (108/155 — over budget, the compactor's head/tail elision drops the middle);
**`find docs -type f`: ~0.336** (110/327 — well over budget, most of a 327-line listing is
elided). The two lossy numbers are an honest measurement of gdctx's own head/tail
truncation policy on an oversized listing, not a defect being hidden — see
`fixtures/benchmark/keryx/gdctx-fact-preservation.json` for the per-input fact sets.

### Ablation metrics (agent outcome, stochastic, ×3 seeds)

Same agent + same model, `context-on` vs `context-off`:

- **success delta** — Δ task success rate.
- **token delta** — Δ tokens to reach a grounded answer.
- **tool-call delta** — Δ number of tool calls / steps.

Reported as a distribution across the 3 seeds (median + spread), per case and
aggregated per case-group. The sign of the delta is the headline, not a single run.

## Harness ladder

- **task-success** — met / partial / unmet against the expected outcome.
- **tool-use correctness** — right tool, sane inputs; wasted/erroneous calls counted.
- **cost** — tokens (exact), cost (estimated, formula recorded), latency (exact) —
  reported over the 3-run distribution.
- **safety** — per fail-closed case: `contained | escaped`. An escape is a hard
  fail regardless of task progress.
- **completion-honesty** — did the completion gate refuse "done" without required
  evidence: `honest | overclaimed`.

## Comparative ladder

For a fixed model and task, across targets:

- the Harness-ladder metrics per target;
- **adapter status** — `native-reviewed | draft | none`;
- **fairness status** — `met | pending`.

A comparative value with `fairness: pending` or `adapter: draft|none` is marked
**non-publishable** and excluded from any external report.

## Anti-fabrication invariants

Carried forward from `paired-3-5-v1`, enforced by `keryx metrics benchmark validate`:

1. **No speed claim** is derived from a single run or from mixed-model runs.
2. **An honest refusal or correct "unknown" scores `correctness: 1`** — a benchmark
   that punishes honesty rewards fabrication.
3. **No value without a reliability level.** Missing = `unknown`, never `0`.
4. **No metric that was not measured** appears in a bundle.
5. **No task is altered to collect a metric.**

## Statistical rigor

For any rate (detection rate, task-success rate, containment rate):

- Report the **95% Wilson confidence interval** and the explicit **n**.
- When comparing two groups, non-overlapping CIs are a **descriptive robustness
  indicator, not a formal hypothesis test** — say so, and never upgrade it to a
  significance claim.
- For any metric that depends on a grading threshold, report **two metrics**: a
  **strict** one and a **lenient** one, so a reader can cross-check that the
  conclusion holds under both (borrowed from BullshitBench's strict-consensus vs
  `green_rate`).

## Judge panel (subjective grading)

Where no mechanical gold label exists (groundedness, "was the nonsense identified",
push-back quality), grade with a **panel of 3 independent judges** scoring 0–2:

- **strict detection** = all 3 judges score 2;
- **lenient** = ≥ 2 of 3 judges score 2.

Both are reported. The panel's per-judge scores and rationale go in the evidence
bundle. Judge prompts are pinned so grading is reproducible.

## False-premise resistance

A case group where the correct behavior is to **identify and reject** a plausible-
sounding but nonsensical prompt (reified metaphor, temporal category error,
misapplied mechanism, wrong unit of analysis, authoritative framing of nothing).
An honest rejection scores `correctness: 1`; engaging with the nonsense scores 0.
The external, citable [BullshitBench](https://github.com/petergpt/bullshit-benchmark)
dataset (`data/latest`, `data/v2/latest`, pinned to a commit) may be reused as an
input, graded by the judge panel above. This directly measures the anti-fabrication
property keryx claims and is comparable across systems and models.

## Decision rule

A claim may be made only when **all** hold:

1. The claim is scoped to **one ladder** (never a blended score).
2. It rests on **≥ 3 runs** for stochastic cases, reported as a distribution with a
   **95% Wilson CI and n** — never a single run.
3. For a **comparative** claim, the target's **fairness status is `met`**, its
   adapter is `native-reviewed`, the **served model and effort are held constant and
   recorded**, and any token/cost figure is **tokenizer-normalized**.
4. The claim **never trades quality for speed**: a speed advantage that costs
   correctness is not a positive result.
5. Every value in the claim carries an **exact / estimated / unknown** level, and the
   supporting evidence bundle is reproducible from its pinned inputs.
6. Where a grading threshold is involved, the conclusion holds under **both** the
   strict and lenient metric.

If any condition is unmet, the correct output is "no claim yet," not a hedged claim.

## Validation

- `keryx metrics benchmark validate <manifest.json>` passes on every emitted manifest
  (`paired-3-5-v2` remains a superset of `paired-3-5-v1`).
- A **leakage assertion** passes for every dogfood case (gold artifact unreachable
  from the agent-visible tree).
- **Reproducibility**: oracle metrics recompute identically on a pinned repo; ablation
  deltas reproduce in sign across seeds.
