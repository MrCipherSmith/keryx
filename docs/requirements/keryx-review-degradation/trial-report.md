# review-degradation trial report (AC10 and AC12), 2026-10-29

Anonymous: counts and classes only. Project: a large React/MobX frontend. Five merged PRs of one author, 11 to 19 files each, 484 to 639 added lines. Ground truth: findings of the two lead human reviewers, hand-labelled once (12 regression, 27 quality; style, nits and process items not counted). Reviewer: `review-degradation` 1.0.0, one run per PR, payload = diff + description + graph consumers (cap 60), no `run-tests`, no project rules, no review comments.

## Reproduction (per PR: ground truth / reproduced)

| PR | regression | quality | as finding | as pre-existing | as question | adjacent only |
|----|-----------|---------|-----------|-----------------|-------------|---------------|
| A | 0 / 1 | 0 / 3 | 0 | 0 | 0 | 0 |
| B | 2 / 5 | 0 / 8 | 0 | 1 | 1 | 1 |
| C | 0 / 0 | 1 / 2 | 1 | 0 | 0 | 0 |
| D | 0 / 1 | 1 / 8 | 1 | 0 | 0 | 3 |
| E | 4 / 5 | 0 / 6 | 0 | 0 | 3 questions (4 points) | 0 |
| total | 6 / 12 | 2 / 27 | 2 | 1 | 4 questions (5 points) | 4 |

(Reproduced = same point at the same or an adjacent place. B regression 2 = one pre-existing item and one question.)

- Strict (a finding of any severity in the findings lane): 2 of 39 (5%).
- Counting the pre-existing and question lanes: 8 of 39 (21%); regression only 6 of 12 (50%), none of them as a finding.
- Draft threshold "at least half reproduced": not met. Threshold "no more than one unconfirmed major per PR": met trivially, the reviewer filed zero majors and zero blockers across the five PRs, while the humans' regression set holds about nine majors.

## Cost (reviewer only; a round without it was not measured)

Tokens per PR: 124k, 148k, 156k, 156k, 159k (total 743k). Wall time per PR: 2.3 to 5.0 min, run in parallel. Tool calls 27 to 54. Findings filed: 4 minor, 3 info, 0 major, plus 7 questions and 4 pre-existing items; the screen would have lowered nothing (no major was filed).

## What the numbers say

1. Without `run-tests` the reviewer cannot attach `probe`/`red-test`, so it demotes real suspicions to questions or info. All six regression hits are questions or pre-existing, not findings.
2. Graph gaps: no importers for two shared button exports and for a modal barrel; the reviewer fell back to symbol search. One consumer was dropped by the cap in one PR.
3. The ground truth includes items outside the skill's question (docs wording, translation terms, test structure, README edits). The in-scope denominator is smaller than 39; it was not recomputed.
4. One run per PR, one model; the match was judged by one reader. Needs an operator spot check.

## Run 2 (skill revised: reading is evidence; graph list first, search fills gaps), 2026-10-29

Same five PRs, same payloads, same method, one run per PR.

| PR | regression | quality | as finding | as pre-existing | as question | adjacent only |
|----|-----------|---------|-----------|-----------------|-------------|---------------|
| A | 0 / 1 | 0 / 3 | 0 | 0 | 0 | 0 |
| B | 1 / 5 | 0 / 8 | 0 | 0 | 1 | 1 |
| C | 0 / 0 | 0 / 2 | 0 | 0 | 0 | 1 (opposite sense) |
| D | 0 / 1 | 1 / 8 | 1 | 0 | 0 | 1 |
| E | 3 / 5 | 0 / 6 | 1 | 0 | 2 | 1 |
| total | 4 / 12 | 1 / 27 | 2 | 0 | 3 | 4 |

- Run 1 vs run 2, all lanes: 8 of 39 (21%) vs 5 of 39 (13%). Regression 6/12 vs 4/12. Findings lane: 2 vs 2. Not better; the revision did not move the result.
- Filed: 3 minor, 3 info, 0 major, 0 blocker (run 1: 4 minor, 3 info, 0 major); 7 questions (7); 5 pre-existing (4). The humans' regression set holds about nine majors; the reviewer still files none.
- What changed in behaviour: a graph gap is now handled (one PR: six subclasses missing from the graph list were found by search and labelled `search-derived`); one hit moved from a question to a finding. Severity stayed at info or minor, so no hit is a major.
- Cost: 635k tokens (run 1: 743k); per PR 130k, 140k, 144k, 154k, 67k; wall time 2.3 to 6.8 min in parallel.

### Method flaw found while matching

The payload is the squash-merge diff, i.e. the state after the human reviewers' findings were fixed. Of the 39 ground-truth items, those marked fixed in the PR cannot be seen in that diff by any reviewer. Items that stayed open or were declined: 12 (+2 unknown). Hits among those 12 in run 2: 3 (25%), plus 1 adjacent. Both runs therefore under-count. A fair trial gives the reviewer the diff as the humans saw it (the commit their comments are anchored to).

## Run 3 (skill v3: severity tightened; payload = diff as the human leads saw it), 2026-10-29

Method fix applied: the diff is taken at the commit the humans' first reviews were anchored to (not the squash). Skill v3: a trigger and outcome read in the code is a finding, `major` when a user gets a wrong, lost or blocked result; a question only for what code cannot answer. Same five PRs, one run per PR.

| PR | regression | quality | as finding | as pre-existing | as question |
|----|-----------|---------|-----------|-----------------|-------------|
| A | 1 / 1 | 0 / 3 | 1 | 0 | 0 |
| B | 2 / 5 | 2 / 8 | 2 | 1 | 1 |
| C | 0 / 0 | 1 / 2 | 1 | 0 | 0 |
| D | 0 / 1 | 5 / 8 | 5 | 0 | 0 |
| E | 4 / 5 | 0 / 6 | 2 | 0 | 2 |
| total | 7 / 12 | 8 / 27 | 11 | 1 | 3 |

- All lanes: 15 of 39 (38%). Run 1: 8 (21%), run 2: 5 (13%). Findings lane: 11 vs 2 vs 2. Regression only: 7 of 12 (58%).
- Draft threshold (half, at the same place AND severity): not met. Same or higher severity than the human item: 6 of 15. Of the 11 human majors, 5 were reproduced at the place, 1 of them as a major (others as minor, info or question).
- Filed: 5 major, 5 minor, rest info or questions, 0 blocker. 4 of the 5 majors match a human item; 1 is a method artifact (the description is the final text, the diff is the earlier, broader one). One minor is also an artifact (two-dot diff on a stale branch). Unconfirmed majors per PR: at most 1 (threshold met).
- Cost: 532k tokens (run 2: 635k, run 1: 743k); per PR 63k, 135k, 125k, 149k, 60k; wall time 3.6 to 6.1 min in parallel. A round without the reviewer was not measured.

### Caveats

1. Two things changed at once (payload and skill). The jump from 13% to 38% cannot be assigned to v3: the pre-fix payload alone exposes the items that were later fixed. A control (v2 on the same pre-fix payloads) would separate them; not run.
2. One run per PR, one model, one reader matching. The v3 wording came from general failure causes, but the ground truth was known to the author of the edit (overfitting risk).
3. The misses are mostly outside the skill's question (docs wording, translations, test structure) or need a running product (typing loss in a large import).

### Public practice (web search, 2026-10-29; figures from a subagent's paraphrase, unverified)

Findings: the vendor's own review works by reading, without running; separate find, verify and rank stages; two axes (confidence and importance) with a publish threshold; a required `file:line` citation for behaviour claims; a separate pre-existing lane (we have it). Reported ceiling for current review agents is low (around 40% of tasks in one benchmark; precision 25 to 38% at recall 12 to 20% in another), so 38% is not out of range. Candidate v4: a "suspicion" tier with an executable check for the author instead of demotion to info; a second, adversarial verify pass; mandatory consumer enumeration.

## Run 4 (skill v4: suspicion tier with "If true" and "Check", refutation pass; same pre-fix payloads as run 3), 2026-10-29

Only the skill changed against run 3 (payloads identical), so this is the clean comparison v3 vs v4. One run per PR.

| PR | regression | quality | findings lane | pre-existing | suspicions |
|----|-----------|---------|---------------|--------------|-----------|
| A | 1 / 1 | 0 / 3 | 1 | 0 | 0 |
| B | 2 / 5 | 0 / 8 | 1 | 1 | 0 |
| C | 0 / 0 | 1 / 2 | 0 | 1 | 0 |
| D | 0 / 1 | 5 / 8 | 3 | 2 | 0 |
| E | 4 / 5 | 0 / 6 | 1 | 1 | 2 |
| total | 7 / 12 | 6 / 27 | 6 | 5 | 2 |

- All lanes: 13 of 39 (33%); run 3: 15 (38%). Regression only: 7 of 12 (58%), unchanged. Quality fell from 8 to 6 (B lost two, C swapped one item for another).
- Same or higher severity than the human item, among hits outside the pre-existing lane: 6 of 8. Both lower ones are on E (a minor finding where the human had a major; a suspicion "minor if true" where the human had a major).
- Filed: 4 major (3 match a human item, 1 not in the ground truth and not confirmed), 6 minor, 2 info findings, 3 suspicions (2 match a human item, one of them "major if true"), 4 pre-existing items, 0 blocker.
- What the new tier did: on E it turned two human items that need a running product (typing loss in a large import, a shared footer layout) into suspicions with a severity if true and a check. It produced no false major from the description-vs-diff artifact of run 3.
- Cost: about 504k tokens (run 3: 532k); per PR 74k, 126k, 122k, 113k, 70k; wall time up to 6 min in parallel.
- Threshold (half at the same place and severity): not met.

Caveats: one run per PR, so run-to-run noise (a few hits either way) is not separated; the 2-hit difference between v3 and v4 is inside it. The suspicion tier changes the quality of a report (severity if true, a check), not its recall.

## Run 5 (skill v5: sweep lists what a swapped mechanism did implicitly; work counted against what it scales with; skill shortened to 191 lines), 2026-10-29

Same pre-fix payloads as runs 3 and 4; only the skill changed. One run per PR.

| PR | regression | quality | findings lane | pre-existing | suspicions |
|----|-----------|---------|---------------|--------------|-----------|
| A | 1 / 1 | 0 / 3 | 1 | 0 | 0 |
| B | 2 / 5 | 1 / 8 | 1 | 1 | 1 |
| C | 0 / 0 | 0 / 2 | 0 | 0 | 0 |
| D | 0 / 1 | 4 / 8 | 2 | 2 | 0 |
| E | 4 / 5 | 0 / 6 | 1 | 1 | 2 |
| total | 7 / 12 | 5 / 27 | 5 | 4 | 3 |

- All lanes: 12 of 39 (31%). Run 4: 13, run 3: 15. Regression only: 7 of 12 (58%) for the third run in a row. Same or higher severity than the human item, among hits outside the pre-existing lane: 6 of 8 (the two lower ones are again on E).
- The mechanism-swap clause did not produce the hit it was written for (a blocked state still matched the old hover styling) and found nothing new on regressions. One new quality hit: a suspicion that a new rule has no step-type gate (B).
- Filed: 1 blocker, 4 major, 6 minor, 3 info findings, 3 suspicions, 4 pre-existing. The blocker is a description-versus-diff gap on D; the canonical severity allows a blocker only for four shapes and this is none of them. Of the 5 blocker or major, 3 match a human item (one of them with the wrong severity, the blocker) and 2 are not confirmed: both are description-versus-diff or stale-branch effects of how the trial payload was built.
- Cost: about 464k tokens (run 4: 504k, run 3: 532k); per PR 70k, 64k, 116k, 147k, 67k; wall time 2.4 to 7.2 min in parallel.

Across runs 3, 4 and 5 (same payloads, three skill versions): 15, 13, 12 hits; regression 7, 7, 7. The differences are inside the noise of one run per PR, and the three versions are not distinguishable on recall. What changed between versions is the shape of the report (suspicions with a check, refutation lines), not how many human findings it reaches.

## AC12: cost of a round with the reviewer against the same round without it

Scope: one PR measured (the pilot, PR B), not five. The operator stopped the measurement after the pilot (2026-10-29): a full-roster base round costs about 1.9M tokens per PR, so the other four were left unmeasured.

Method. The round without the reviewer is the keryx review roster for the PR at its pre-fix commit (`keryx review plan`: 15 dispatches, profile `full`, no `review-degradation`), run as one sonnet subagent per reviewer on the same payload style as the degradation trial. The orchestrator itself (planning, verify stage, ingest) was not run, so the round figure below is a lower bound and the reviewer's share is an upper bound.

| | tokens | wall time | reviewers |
|---|---|---|---|
| Round without `review-degradation` (PR B) | 1 885 167 (101k to 148k each, mean 126k) | 187 s in parallel (longest reviewer); about 21 min summed | 15 |
| `review-degradation` v5 alone (PR B) | about 64k | not recorded for this PR; 2.4 to 7.2 min across the five runs | 1 |
| Share added | about 3.4% tokens | up to the reviewer's own run time if it is the longest in a parallel wave, nothing otherwise | |

Across the five trial PRs the reviewer cost 464k tokens in total (run 5). If each of the other four base rounds is at least as large as the pilot's (their payloads are larger, 129k to 140k characters against 55k), the five-PR base is at least 9M and the share is 5% or less. This is an estimate, not a measurement.

Extra findings kept after ingest: not measured for the base round (its reviewers were not run through `keryx review ingest`). The reviewer's own output on the pilot PR: 2 major and 1 info finding, 2 suspicions, 1 pre-existing item; the `degradation-no-evidence` screen would have lowered nothing.

Effectiveness on the pilot PR (13 human lead findings, one reader matching, approximate):

| | reached | note |
|---|---|---|
| Round without the reviewer | about 6 of 13 | 4 of 5 regressions, 2 of 8 quality items (one of them the major translation-term item) |
| `review-degradation` v5 | 3 of 13 (2 regression, 1 quality) | the AC10 count for this PR |
| Reached only by `review-degradation` | 0 | every point it reached was also reached by at least one base reviewer (the load-time normalisation regression was the convergent major of the base round) |
| Missed by both | 7 of 13 | the pipeline-level warning that blocks Run and Publish (the one human major regression), test-structure items, scope creep, documentation wording; one item (an enum list re-typed in a legacy check) was not classified |

What the pilot says: the reviewer is cheap next to a full round (about 3% of tokens) and added no reproduced human finding on this PR. Its value on this PR is the shape of the report (a trigger, an outcome and a check per item), not recall. One PR cannot show whether it adds anything on the others; on the trial numbers (31% of items, 58% of regressions for three skill versions) its overlap with the base round on the other four PRs is unknown.

## Promotion: options for the operator

Not decided here. The decision belongs to the operator (AC12).

1. Keep profile `full` only (today). Cost: nothing. The reviewer stays available for a deliberate deep round.
2. Move to `recommended`. The change is one profile list in `src/gdskills/catalog.ts` (`skill("review-degradation", "review", ["full"], ...)` gains `recommended`) plus the AC6 routing test. Cost: about 3 to 5% on every recommended round. Evidence for: low cost, suspicion tier gives the author an executable check. Evidence against: no unique reproduced finding on the pilot, recall flat across three skill versions, base-round overlap measured on one PR only.
3. Measure the other four PRs first (about 7.5M tokens), then decide.

## Decision (operator)

Not decided.
