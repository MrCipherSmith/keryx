# Review — flow 331, Jev review benchmark (PR #721)

One round ran against the flow 331 diff (`bench/jev-review/` — `types.ts`,
`build-dataset.ts`, `dataset.json`, `metrics.ts`, `cost-cap.ts`,
`adapters/{ci-triage,review-conform,not-available,registry}.ts`, `report.ts`,
`run.ts`, plus tests, `README.md`, `results-2026-09-25.{md,json}` and
`docs/report/jev-review-benchmark-2026-09-25/results.md`), which builds a
labelled dataset from this repository's own review packages
(`.metaproject/reviews/*`, `.metaproject/flows/*/reviews/*`) and runs each
Jev-touching pipeline component through a common adapter, `without-jev` vs
`with-jev`, reporting accuracy/precision/noise, calls, cost and wall-clock
with an honest confidence interval next to every rate.

The branch carries three commits: the initial implementation
(`da74388e`), a merge of `origin/main` (`4f6ca87a`), and a same-PR fix
commit, `aba08eddee3f72d1e03e625e6fa7ef51a5679557` — "scrub identities from
the dataset, anecdotal per rate, honest caveats" — whose own message frames
it as a response to review of PR #721. That third commit is the PR's head
(`headRefOid`), so **round 1 reviewed the branch already carrying that
commit**, not the bare initial implementation. There was no further
fix-and-re-review cycle after round 1: it read the final state, approved,
and left three items on the record as accepted, documented limitations
rather than defects to fix before merge.

**Round 1 approves**, with three caveats accepted as known limitations:

- **F-001 (class imbalance in the AC1 dataset)** — the dataset's two scored
  disposition labels are wildly skewed: 1351 `true-positive` (acted-on)
  against 3 `dismissed-incorrect`, per the dataset's own committed counts
  and the PR description. A precision figure computed against these labels
  mostly reflects how rarely a human reviewer marks a finding
  `dismissed-incorrect` at all, not a clean false-positive rate — with only
  3 negatives in the whole dataset, one mislabelled or borderline
  disposition can swing the ratio by roughly a third. This is a property of
  the repository's own review history (only 3 findings across 254 review
  packages were ever disposed `dismissed-incorrect`), not something the
  fix commit could resolve by changing code — the third commit instead
  makes the caveat impossible to miss, moving it to a labelled "Caveat"
  block in `README.md` stated immediately before AC1's precision-mapping
  section, ahead of any precision number. The underlying imbalance itself
  is unchanged and accepted as a known limitation: `README.md` says
  outright that "hand-labelled samples … are required before quoting a
  precision number from this dataset as a finding rather than a
  description of reviewer behaviour."
- **F-002 (identity-scrub gap)** — free text copied from a finding's
  `disposition.evidence` (and other free text) into `dataset.json` is
  passed through `build-dataset.ts`'s `scrubIdentity`, which replaces
  personal handles/names and email addresses with the neutral token
  `operator`. The scrub is allowlist- and regex-based — "a small documented
  list of known handles/names plus one email regex" (`README.md`,
  `build-dataset.ts` line ~90) — not a general PII detector, so a handle or
  name not on that list, or an identifier in a shape the regex does not
  match, would pass through unscrubbed. This is disclosed as a caveat in
  `README.md` rather than closed: structural provenance fields (`prRef`,
  `reviewId`, …) are explicitly left untouched by design (they are GitHub
  provenance, not free text), and the free-text scrub's coverage is
  documented as a known list, not a guarantee. Accepted as a known
  limitation given the dataset is built only from this repository's own
  already-public review packages, not private data.
- **F-003 (anecdotal per-rate concern)** — the committed live run
  (`results-2026-09-25.md/json`) measured `ci-triage` accuracy/precision at
  n=8 (both arms) and `review-conform`'s components at n=0-5 for
  precision/noise — all below the benchmark's own `ANECDOTAL_THRESHOLD_N`
  of 10. `report.ts`'s `formatRate` labels each such rate **anecdotal**
  inline by its own `n` (the fix commit specifically moved this from a
  component-level label to a per-rate one, since a component's overall
  case count can be larger than the n a specific rate — e.g. precision's
  flagged-with-known-correctness subset — was actually computed over), and
  a `--repeat 2` rerun is reported as a "range over N repeats" rather than
  a bootstrap CI (which the code itself says is not statistically
  meaningful below N=5). The labelling is honest and load-bearing
  (`report.test.ts` exercises both the anecdotal tag and the "range" vs.
  "bootstrap" wording), but the small-n condition itself is inherent to a
  benchmark that caps live spend at $0.10/300 calls, not something this PR
  fixes — it is accepted as a known limitation of the first live run, to be
  narrowed by future `--live --repeat` runs at higher n rather than by
  further code changes.

None of the three caveats blocked approval; each is disclosed at the point
in the code or docs where a reader would otherwise draw an unsupported
conclusion (a `README.md` "Caveat" block ahead of AC1's label mapping and
ahead of AC3's precision section, and `formatRate`'s inline `**anecdotal**`
tag ahead of every affected number), and all three are internally
documented, not silently accepted.

PR #721 squash-merged as `335f730c395560cf316be1dea0d48e148f5d40cc` into
`main` (verified via `gh pr view 721 --json mergeCommit,mergedAt,headRefOid,state`:
`mergeCommit.oid == 335f730c395560cf316be1dea0d48e148f5d40cc`, `state ==
MERGED`, `mergedAt == 2026-09-25T14:38:47Z`, `headRefOid ==
aba08eddee3f72d1e03e625e6fa7ef51a5679557`). CI on the PR head was green
across every non-skipped check (`typecheck-and-tests`, `mkdocs build
--strict`, the four `client matrix` jobs, `standard-baseline`,
`dependency-audit`, `metrics-contract`, and others — all `SUCCESS`; only
"deploy to GitHub Pages" is `SKIPPED`, not applicable to a PR build), per
`gh pr view 721 --json statusCheckRollup`. `git log --oneline origin/main
-- bench/jev-review` shows a single commit touching this module on `main`
— the squash merge itself — so no further fix landed after merge; the
three caveats above remain, on `origin/main` today, exactly as accepted at
round 1.

```keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "sonnet-reviewer",
    "severity": "minor",
    "file": "bench/jev-review/dataset.json",
    "problem": "The AC1 dataset's two scored disposition labels are heavily imbalanced: 1351 `true-positive` (acted-on) against only 3 `dismissed-incorrect`, per the dataset's own committed counts.",
    "impact": "A precision figure computed against these labels mostly reflects how rarely a human reviewer marks a finding `dismissed-incorrect` at all, not a clean false-positive rate for whatever is being scored; with only 3 negatives in the whole dataset, one mislabelled or borderline disposition can swing the ratio by roughly a third.",
    "suggested_fix": "Not fixable by this PR alone (the imbalance reflects this repository's own review history); a dedicated hand-labelled precision/recall sample (AC3's `addedTruePositives`, or a fresh labelling pass) is the documented path before quoting a precision number from this dataset as a finding.",
    "evidence": "bench/jev-review/README.md, \"Caveat — class imbalance\" block: \"the dataset's two scored labels are wildly imbalanced — 1351 true-positive (acted-on) against 3 dismissed-incorrect... Hand-labelled samples... are required before quoting a precision number from this dataset as a finding rather than a description of reviewer behaviour.\" Same figures (1351 TP / 3 FP / 284 unlabeled) appear in PR #721's description.",
    "confidence": "high"
  },
  {
    "id": "F-002",
    "reviewer": "sonnet-reviewer",
    "severity": "minor",
    "file": "bench/jev-review/build-dataset.ts",
    "problem": "`scrubIdentity` replaces personal handles/names and email addresses in free-text evidence with the token `operator`, but it is allowlist- and single-regex-based (\"a small documented list of known handles/names plus one email regex\"), not a general PII detector.",
    "impact": "A handle, name or identifier not on the known list, or in a shape the regex does not match, would pass through into the committed `dataset.json` unscrubbed.",
    "suggested_fix": "Documented as a known-limitation caveat rather than closed; a follow-up could widen the scrub to a broader pattern set or a dedicated PII-detection pass if the dataset is ever built from a repository with a wider contributor list.",
    "evidence": "bench/jev-review/README.md, \"Caveat — identity scrubbing\" block; bench/jev-review/build-dataset.ts ~line 90 (\"a small, documented list of known [handles]\") and IDENTITY_TOKEN/scrubIdentity implementation; bench/jev-review/build-dataset.test.ts's scrubIdentity describe block covers only the documented handles/email pattern, not arbitrary PII.",
    "confidence": "high"
  },
  {
    "id": "F-003",
    "reviewer": "sonnet-reviewer",
    "severity": "info",
    "file": "bench/jev-review/report.ts",
    "problem": "The committed live run's rates (ci-triage accuracy/precision at n=8 both arms; review-conform's noise/precision at n=0-5) all fall below the benchmark's own ANECDOTAL_THRESHOLD_N of 10, and the `--repeat 2` variance figure is a 2-point range, not a statistically meaningful interval.",
    "impact": "Every headline number in the first live run (results-2026-09-25.md/json) is anecdotal by the benchmark's own definition; conclusions drawn from it about whether Jev helps ci-triage are not yet statistically solid.",
    "suggested_fix": "Not a code defect — the per-rate **anecdotal** labelling and honest \"range over N repeats\" wording (rather than a fake bootstrap CI) already surface this at the point of reading; narrowing it further means running more live samples (n>=10, repeat>=5), a cost/scope decision for a later run, not a fix to this PR.",
    "evidence": "bench/jev-review/results-2026-09-25.md: `ci-triage | without-jev (n=8) **anecdotal**` / `with-jev (n=8) **anecdotal**`; bench/jev-review/report.ts's formatRate marks a rate anecdotal per its own n < ANECDOTAL_THRESHOLD_N (metrics.ts, ANECDOTAL_THRESHOLD_N=10); README.md's AC3/AC4 section: \"a bootstrap over so few points is descriptive, not a real interval... the report labels it honestly as 'range over N repeats' instead of 'bootstrap 95% CI'.\"",
    "confidence": "high"
  }
]
```
