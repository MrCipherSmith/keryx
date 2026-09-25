# Jev review benchmark — results (2026-09-25)

Numbers on this page are taken directly from the committed
[`bench/jev-review/results-2026-09-25.json`](../../../bench/jev-review/results-2026-09-25.json)
(a live run of `bun bench/jev-review/run.ts --live --repeat 2`). See
[`bench/jev-review/README.md`](../../../bench/jev-review/README.md) for how
the dataset was built, what each component/arm compares, and the honesty
rules this report follows (n and a 95% confidence interval next to every
percentage; anything with n < 10 is called out as anecdotal rather than a
finding).

## Dataset

Built from this repository's own review history: 254 review packages, 1638
findings, of which 1351 are labelled `true-positive` (acted on),
3 are labelled `false-positive` (dismissed as incorrect), and 284 are
`unlabeled` (dismissed for a reason that says nothing about accuracy, or
never dispositioned) — see the README for the exact label mapping.

**Caveat — class imbalance:** 1351 acted-on against 3 dismissed-incorrect is
a heavily imbalanced pair of labels. A precision number computed against
them (true-positive / (true-positive + false-positive)) mostly reflects how
rarely a human reviewer marks a finding `dismissed-incorrect` at all — with
only 3 negatives across the whole dataset, one borderline disposition moves
the ratio by a third — not a clean false-positive rate for whatever is
being scored. Hand-labelled samples are required before quoting a precision
number computed from these labels as a finding.

## What Jev improved

Nothing, on this run. `review-conform` has no non-Jev baseline to compare
against (the component does not exist without Jev), so its own number is
descriptive rather than comparative: on the committed fixture PR, its
with-jev arm flagged 1 of 5 reference-document clauses as
`likely-violated` (2 Jev calls, $0.00004) — a candidate finding a
Jev-free pipeline could not have raised at all, but not hand-labelled, so
this is a count, not a precision figure.

## What it did not improve

`ci-triage`'s with-jev arm scored **37.5% accuracy (n=8, 95% CI [13.7%,
69.4%])** against the labelled eval set (`src/commands/fixtures/
ci-triage-eval/`), against a synthetic **without-jev baseline of 50.0%
(n=8, 95% CI [21.5%, 78.5%]) — a comparator that always predicts
"real-regression"**, the conservative escalate-everything default (no
Jev-free CI triage exists in this codebase to compare against for real).
On this run, the naive baseline that never calls a model outscored Jev's
classifier. n=8 is anecdotal by this benchmark's own rule (< 10) — this is
one data point, not a verdict on Jev.

**Run-to-run variance, measured (not assumed):** repeating the with-jev
arm twice gave 37.5% and 50.0% accuracy — mean 43.8%, stddev 6.3%, on the
identical 8 cases. A live model call over the same inputs did not return
the same verdict both times. Any single-run accuracy figure for this
component, including the 37.5% above, should be read against that spread,
not as a fixed number.

**Caveat — this is a range, not a confidence interval:** the underlying
`results-2026-09-25.md` reports this spread as a "range over 2 repeats:
[37.5%, 50.0%]", not a "bootstrap 95% CI". With only 2 repeats a percentile
bootstrap has too little data to behave like a real interval — it collapses
to the plain min/max of the two values measured — so this benchmark labels
that interval as a range, not a statistical CI, whenever a run has fewer
than 5 repeats.

## At what cost

The entire live run — every live-capable component, plus the repeat for
variance — cost **$0.001695** across **34 Jev calls** and took **~238
seconds** of wall-clock time (dominated by live `gh run view` lookups for
the CI-triage cases, not by Jev itself). Both are far under this
benchmark's cap ($0.10, 300 calls) — see `bench/jev-review/cost-cap.ts`.

## Components not yet measurable

Three components registered in this benchmark's adapter interface have no
code in this worktree yet and are reported as `not available` in every
run, not silently omitted: `flow-check-ac` (flow 328), `review-jev-rules`
(flow 330), and severity calibration / duplicate merge (a later,
not-yet-numbered flow). When each lands, its adapter replaces the stub and
this page's next run picks up real numbers for it.

## Reading this honestly

- Every rate above is quoted with its n and a 95% Wilson confidence
  interval. n=8 for both `ci-triage` arms and n=5 for both `review-conform`
  arms — small samples, called out as anecdotal in the underlying report,
  not treated as a verdict here.
- `review-conform`'s precision/noise are "not measured", not zero: this
  repository has no ground-truth label for whether its fixture PR's
  flagged clause is actually a true or false positive, and a fabricated
  number would be worse than an honest gap.
- This page will be superseded by a later `results-<date>.md` once flow
  328/330/the severity-calibration flow land and this benchmark can compare
  more than two components.
