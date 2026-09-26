# Jev in review — what we measured

Jev (TypeSafe's "System One", reached through OpenRouter — `src/harness/decision/jev-client.ts`) is a
small, cheap probability model: it answers a `noul` (a probability, `0..1`) or a `choice` question over
a bounded piece of state. `review-orchestrator` and its sibling commands have tried it in several
different roles across the review domain. This page is the honest scoreboard: where it measurably
helps, where it measurably does not, and where the answer is still "not measured yet".

All the numbers below come from one live benchmark run on a real project — a large production
React/MobX frontend, not a toy repository. No project name is used; the numbers are what they are
regardless of whose codebase produced them.

## PROVEN: CI triage

`keryx review ci-triage` (flow 306/307) sorts a failed CI job's log into `flaky` / `regression` /
`infra`, scored by Jev over a redacted, bounded log excerpt plus a small block of deterministic
signals computed first.

| | Jev | Sonnet 5 reading the same log |
|---|---|---|
| Accuracy on 103 reliable labels | **38%** | 25% |
| Statistical significance | p = 0.035 | — |

Under an explicit cost model, this cuts developer minutes per failure from **30 to 15.4**. This is
the one Jev-in-review integration with a clean, positive, statistically significant result, and it
is wired into `review-orchestrator` as Step 0b: on a PR whose checks are red, triage each failed run
and put the verdicts in the report — advisory only, never a gate, never a finding on its own.

## NOT RECOMMENDED: three CLI-engine reviewers, measured weaker than a strong model

Three of the `review jev-*` CLI-engine reviewers (dispatched by `review-orchestrator`'s Wave B
as commands rather than LLM sub-agents) were benchmarked against a strong-model baseline and lost:

| Reviewer | What it does | Jev | Baseline | Verdict |
|---|---|---|---|---|
| `review-jev-risk` | Ranks which files/hunks a reviewer should focus on | Top-3 recall **21%** | "largest diff first": 30%; Sonnet 5 alone: 44% | **Off by default** |
| `review-jev-contract` | Checks false claims in PR descriptions against the diff | Caught **12.5%** of false claims | Sonnet 5: 67.5% | **Off by default** |
| `review-jev-rules` | An extra reviewer dispatched alongside an already-strong reviewer | **+0 findings** | — | **Not useful on top of a strong reviewer** |

None of these are removed — a project can still turn them on — but `keryx review jev-profile`'s
recommended profile leaves all three off, and `review-orchestrator/SKILL.detail.md` states the
verdicts next to the gating instructions so nobody re-discovers this by re-running the benchmark.

## EXPERIMENTAL: not measured yet

`review-jev-scenarios`, `review-jev-docs`, and `review-jev-comments` have not been put through this
benchmark. They stay available, opt-in, off by default, and unlabelled beyond "experimental" — an
absence of a negative result is not a positive one.

## A cascade, when the strong model would run many times anyway

Used as a plain rule classifier (not in any of the roles above), Jev scores **88% accuracy
(AUROC 0.95) at 1/170th of a strong model's cost**. A cascade — Jev screens, a strong model confirms
only what Jev flags — halves the strong-model call count at the same precision. This only saves money
where the strong model would otherwise be called many times per round; it is not itself one of the
review-domain integrations above.

## UNMEASURED, MOST PROMISING: reviewer selection (`jev-select`)

`review-orchestrator` dispatches roughly two dozen sub-agent reviewers per round, each a separate
strong-model run, and nothing before flow 344 asked "does THIS reviewer have anything to say about
THIS diff" before paying for all of them. Reviewer (sub-agent) *selection* — not risk-ranking within
a diff, not contract-checking, selection of which reviewers even run — is the cost lever this
benchmark named as the most promising one, and it is also the one lever nothing above has measured.

`keryx review jev-select` (flow 344) exists to make that lever usable *before* it is measured,
without repeating review-jev-risk's mistake of shipping an unmeasured lever that can silently cost
coverage:

- **Recall-first.** A candidate reviewer is skipped only when Jev's probability is *below*
  `review.jev.select_skip_below` (default `0.15`) — a low bar, biased toward keeping reviewers.
- **A core safety set is never skipped.** `review-logic`, `review-architecture`,
  `review-security-code`, and `review-highload` (Wave A) are never dropped by `jev-select`, whatever
  Jev answers.
- **It fails open.** No opt-in, no credential, or any Jev error during the run — every remaining
  candidate is kept, with a reason recorded, and the command exits `0`. This is the one
  `review.jev.*` gate in this codebase that does not refuse; every other one above refuses cleanly
  instead.
- **Every decision is recorded**, including the skips, in the report's scope section
  (`skipped by Jev selection (advisory)`) — so a later round can check whether a skipped reviewer's
  domain surfaced a real finding anyway, which is how this lever eventually gets its own verdict.

## Recommended profile

```bash
keryx review jev-profile show              # current state, next to each verdict
keryx review jev-profile --apply recommended
```

`--apply recommended` turns on `ci_triage`, `select`, and `edit_guard` (a separate, parallel
feature — `keryx review jev-edit-guard`, the recommended Jev step during the FIX phase, when the
author's agent applies fixes; this profile only sets the key), and leaves `risk`, `contract`,
`rules`, `scenarios`, `docs`, and `comments` off. It merge-writes `.metaproject/tasks.config.json`,
touching only the `review.jev.*` keys it names.

See [cli-reference.md](./cli-reference.md) for the full flag reference of every command named here,
and `review-orchestrator/SKILL.detail.md` (`.metaproject/skills/gdskills/review/review-orchestrator/`)
for how each is wired into a review round.
