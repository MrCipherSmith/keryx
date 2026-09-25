# Jev review benchmark (flow 331)

Does Jev (TypeSafe "System One" on OpenRouter — typed `noul`/`choice`
answers, `src/harness/decision/jev-client.ts`) actually improve keryx's
review pipeline? This benchmark compares `without-jev` and `with-jev` arms
of the pipeline's Jev-touching components on a labelled dataset built from
this repository's own review history, and reports precision/recall/noise,
cost and wall-clock, with honest confidence intervals.

It is the numeric backbone for an article about Jev in the review pipeline
— every number in `results-*.md` came out of a run recorded in the sibling
`results-*.json`, nothing is invented or backfilled.

## Layout

| file | what |
|---|---|
| `types.ts` | shared vocabulary: `Dataset`, `ComponentAdapter`, `Arm`, etc. |
| `build-dataset.ts` | AC1 — builds `dataset.json` deterministically from `.metaproject/reviews/*` and `.metaproject/flows/*/reviews/*` |
| `dataset.json` | committed output of the builder, regenerate with `bun bench/jev-review/build-dataset.ts` |
| `metrics.ts` | precision/recall/noise/accuracy with Wilson 95% CIs (reuses `src/metrics/benchmark.ts`), plus bootstrap variance across repeated runs |
| `cost-cap.ts` | the `--max-cost`/call-count cap a live run is bound by |
| `adapters/` | one adapter per component, behind the common `ComponentAdapter` interface (AC2) |
| `report.ts` | AC4's honest-reporting rules, applied when rendering `results-*.md` |
| `run.ts` | the CLI entry point |
| `fixtures/conform-project/` | a scratch project root (its own `.metaproject/tasks.config.json`) the `review-conform` adapter runs the CLI in, so this benchmark never has to opt this repository's own config into `review.jev.conform` |

## Running it

```bash
# rebuild the dataset from this repository's current review history
bun bench/jev-review/build-dataset.ts

# offline (default): every component replays committed fixtures — hermetic, no network
bun bench/jev-review/run.ts

# live: real gh + Jev calls where a component supports --live (ci-triage only — see adapters/review-conform.ts)
env -u OPENROUTER_API_KEY bun bench/jev-review/run.ts --live

# tighter cap, and repeat the with-jev arm 3x to measure run-to-run variance (AC4)
env -u OPENROUTER_API_KEY bun bench/jev-review/run.ts --live --max-cost 0.05 --repeat 3
```

**Live ci-triage needs `review.jev.ci_triage: true` in THIS repository's own
`.metaproject/tasks.config.json`** — unlike `review-conform` (which runs in
its own scratch project, `fixtures/conform-project/`), ci-triage's `--live`
path needs a real `git`/`gh` remote to resolve the CI runs it looks up, so
it cannot run from a bare scratch directory. It is opt-in for a reason
(sends a redacted log excerpt to OpenRouter/TypeSafe), so this benchmark
does not flip it on for you: before a `--live` run, add that key to this
repository's `.metaproject/tasks.config.json` yourself, run the benchmark,
then remove it again — exactly what produced the committed
`results-<date>.*` in this directory (the flow 331 journal records the
before/after `git status`).

`--max-cost` defaults to **$0.10**; the runner also refuses to exceed
**300** Jev calls in one run regardless of `--max-cost` (`cost-cap.ts`).
Both are hard caps: the offline replay of a component is run FIRST as a
cost estimate (the same tokens go to Jev either way — offline just replays
a recorded answer), and a live run whose estimate already implies breaking
the cap is refused before a single live call; a live run whose REAL spend
crosses the cap mid-run has its results discarded rather than committed
partially. See `cost-cap.ts`'s file header for the exact two-stage design.

## AC1: the dataset and its label mapping

`dataset.json` is built from PUBLIC data already committed to this
repository: review packages under `.metaproject/reviews/*` and
`.metaproject/flows/*/reviews/*` (`findings.json`/`manifest.json`/
`report.md`), the disposition ledger
(`.metaproject/reviews/dispositions.json`), and each finding-owning flow's
`flow.json` (frozen AC checksum + which are confirmed) and
`acceptance-criteria.md`. No PR-comment ledger, no credential, nothing
under `~/work`.

Every finding is reduced to one label:

```
true-positive  <- disposition.state === "acted-on"
false-positive <- disposition.state === "dismissed-incorrect"
unlabeled      <- everything else, including "unknown"
                  (dismissed-wont-fix / dismissed-out-of-scope /
                   dismissed-deprioritised / answered-disagree)
```

This is the same rule `scripts/review-precision-baseline.ts` already
applies to its own precision ratio (see that script's file header for the
full argument): only `acted-on` and `dismissed-incorrect` say anything
about whether a finding was RIGHT. A finding dismissed as out-of-scope was
never wrong — it was never asked to be right — and counting it as a false
positive would reward rejecting scope rather than being accurate.
`unlabeled` findings are still counted (`dataset.counts.byLabel`) and
reported; they are excluded from precision/recall denominators.

**Caveat — class imbalance (read before quoting a precision number from this
dataset):** as of this writing the dataset's two scored labels are wildly
imbalanced — 1351 `true-positive` (acted-on) against 3
`dismissed-incorrect`. A precision figure computed against these labels
(true-positive / (true-positive + false-positive)) mostly reflects how
rarely a human reviewer marks a finding `dismissed-incorrect` at all, not a
clean false-positive rate for whatever is being scored — with only 3
negatives in the whole dataset, one mislabelled or borderline disposition
can swing the ratio by a third. Hand-labelled samples (AC3's
`addedTruePositives`, or a dedicated precision/recall pass against a fresh
sample) are required before quoting a precision number from this dataset as
a finding rather than a description of reviewer behaviour.

**Caveat — identity scrubbing:** `evidence` text (and other free text)
copied from `findings.json`'s `disposition.evidence` or the disposition
ledger into `dataset.json` has personal handles, names and any email
address replaced with the neutral token `operator` before it is written —
see `build-dataset.ts`'s `scrubIdentity` (a small documented list of known
handles/names plus one email regex). Structural fields (`prRef`,
`reviewId`, …) are left untouched: those are GitHub provenance, not free
text.

Disposition resolution order (also mirrored from that script, reimplemented
here rather than imported because its functions aren't exported and its
`main()` runs on import): the finding's own `disposition` field, then a
`closed by \`<sha>\`` marker in the package's `report.md` (only when this
repository actually has that commit), then a row in the disposition ledger,
then `unknown`. Every finding that could not be resolved through the first
three is `unlabeled` by construction, not by omission — `dataset.problems`
lists anything that looked like evidence but didn't check out (a `closed
by` marker naming a commit this repo doesn't have, a ledger row for a
finding that isn't on disk).

Regenerate with `bun bench/jev-review/build-dataset.ts`; the run is
deterministic except for `generatedAt` (`build-dataset.test.ts` asserts
this on fixture flows, not the real repository, so the test is independent
of how many review packages this repository happens to have today).

## AC2: components and adapters

Every adapter implements `ComponentAdapter` (`types.ts`): `run(arm, ctx)`
returns a `ComponentResult`, either an available result carrying
per-item predictions + usage, or a `not available` row with a reason.
`registry.ts` registers, in order:

1. **`ci-triage`** (real) — `without-jev` is a synthetic "always
   real-regression" baseline scored against
   `src/commands/fixtures/ci-triage-eval/manifest.json`'s truth labels
   (there is no non-Jev CI-triage in this codebase to compare against —
   Jev IS the classifier, so the baseline is documented as synthetic
   everywhere it's reported). `with-jev` shells to `bun <cliPath> review
   ci-triage --eval <manifest> --json [--live]`.
2. **`review-conform`** (real) — `without-jev` is "no automated
   conformance checking" (every clause `not-evaluated`, since the component
   doesn't exist without Jev). `with-jev` shells to `bun <cliPath> review
   conform --ref ... --fixtures ... --json`. This CLI verb has **no
   `--live` flag** (`CONFORM_FLAGS` in `src/commands/review.ts` — checked,
   not assumed), so both the offline and the "live" run of this benchmark
   report the identical offline-replayed number for this component; the
   report says so.
3. **`flow-check-ac`**, **`review-jev-rules`**, **`severity-calibration`**
   (stubs, `adapters/not-available.ts`) — flow 328, flow 330, and a later
   not-yet-numbered flow are in flight in other worktrees. These report
   `not available` for both arms, unconditionally, with no code dependency
   on those flows' CLI verbs (which don't exist in this worktree). When one
   of those flows lands here, replace its stub with a real adapter
   following the same `ComponentAdapter` shape — do not add a fourth kind
   of registration.

Every `bun <cliPath> ...` call shells to **this worktree's** `src/cli.ts`
via the `bun` binary running the benchmark (`process.execPath` /
`AdapterRunContext.bunPath`), never the installed `keryx` binary on `PATH`
— the installed build lags the working tree (a known constraint; see flow
331's `context.md` item 3), and a benchmark that measured the wrong build
would not be measuring this change.

## AC3/AC4: metrics and honesty rules

`metrics.ts` computes, per component/arm:

- **accuracy** — `correct / attempted`, only when every attempted
  prediction has a known-correct/known-wrong outcome (closed-world,
  e.g. ci-triage's 8 labelled cases). `null`, not a partial number, the
  moment any prediction is unscored.
- **precision** / **noise** — `true-positive / flagged` and `false-positive
  / flagged`, only over flagged predictions with known correctness
  (open-world detection, e.g. review-conform's `likely-violated` clauses).
- **addedTruePositives** — AC3's "added true positives not found by the
  existing reviewers (hand-labelled sample)". This is `null` in every run
  this codebase produces unattended, because hand-labelling is,
  definitionally, a human act. Candidate counts (e.g. how many clauses came
  back `likely-violated`) are surfaced as free-text notes, never smuggled
  into this field — see `adapters/review-conform.ts`.
- **Jev calls, input tokens, cost, wall-clock** — from each adapter's
  `ComponentUsage`.

AC3's own example of precision/recall — "a Jev-rules finding matching a
human-acted-on finding at the same file/region" — describes a
finding-GENERATING component matched against the AC1 dataset's labelled
findings. That match is exactly what `AdapterRunContext.dataset` exists
for (every adapter receives the built dataset), but the only component
this repository can run today that generates findings against arbitrary
code (`review-jev-rules`, flow 330) is a `not available` stub.
`ci-triage` classifies whole CI runs, not file/region findings, so it is
scored against its own eval set's truth labels instead (`accuracy`, not
precision/recall against the AC1 dataset); `review-conform` checks a
reference document's clauses, a different signal domain the AC1 dataset
carries no labels for at all, so its `correct` is honestly `null`
throughout, and its precision/noise are reported as "not measured".
When flow 330 lands and a real `review-jev-rules` adapter replaces its
stub, THAT adapter is where `correct` gets computed by matching its
findings against `ctx.dataset.findings` at the same file/region —
`metrics.ts`'s `precision`/`noise` computation already does the right
thing the moment an adapter supplies real `correct` values; nothing else
needs to change.

`report.ts` encodes AC4's rules directly rather than leaving them to
convention:

1. `formatRate` is the only place this benchmark renders a percentage, and
   it never renders a bare one — every rate carries its `n` and a 95%
   Wilson CI (`src/metrics/benchmark.ts`'s `deriveRate`/`wilsonInterval`,
   already this repository's honesty primitive for exactly this problem —
   `metrics-and-validation.md` §M07/§M08).
2. Anecdotal labelling is **per rate, not per component**: `accuracy`,
   `precision` and `noise` each carry their own `n` — the denominator that
   rate was actually computed over (e.g. precision's flagged-with-known-
   correctness subset, which can be far smaller than the component's
   overall case count) — and `formatRate` marks THAT rate **anecdotal**
   inline the moment its own `n < 10`. A component with a large overall `n`
   can still report an anecdotal precision; the component-level `(n=…)` tag
   next to the arm name is context, not a substitute for each rate's own
   check.
3. `--repeat N` (live only — offline replay is deterministic, so repeating
   it would report a fake zero variance) reruns each available with-jev
   arm's accuracy-bearing component N times and reports mean/stddev across
   the repeats in its own report section, present only when the run
   actually measured any. The interval next to it is a percentile bootstrap
   95% CI only when `N >= 5`; below that (e.g. the committed `--repeat 2`
   runs) a bootstrap over so few points is descriptive, not a real
   interval — it collapses to the plain min/max of the values measured — so
   the report labels it honestly as "range over N repeats" instead of
   "bootstrap 95% CI".

## AC5: offline vs. live

Offline is the default and what CI/`bun test` run: every adapter replays
committed fixtures (`src/commands/fixtures/ci-triage-eval/`,
`src/commands/fixtures/conform/`) — no network, no credential needed beyond
a syntactically-present one (the adapters inject a synthetic key for the
offline subprocess so the benchmark's hermeticity does not depend on
whatever credential happens to be saved in the ambient environment).
`--live` calls the real `gh`/Jev endpoint for the `ci-triage` component
only (see AC2 above for why `review-conform` has no live path).

## AC6: the committed live run

`results-<date>.json`/`results-<date>.md` are the output of the most
recent `bun bench/jev-review/run.ts --live` run, committed as-is. The
sibling `docs/report/jev-review-benchmark-<date>/results.md` page restates
only numbers that appear in that JSON — see its own header.
