# Flow 458 evaluation (AC10)

Live round-2 simulation, reviewers on Sonnet with identical prompts in both arms. DELTA = the new `review plan` round (fix slices + new slices); FULL = whole-branch re-review base...head with the 9-role roster.

| PR | Dispatches delta / full | Tokens delta / full | Round-2 truth found delta / full |
|---|---|---|---|
| #1005 (round 2 at f5d3385f) | 11 / 18 | 1.26M / 1.70M | 0 / 0 (F-066 missed by both; F-067 is outside the PR diff) |
| #992 (round 2 at d9ccfb6c) | 9 / 18 | 1.00M / 1.75M | 2 of 5 (1 major) / 3 of 5 (2 majors) |

Delta costs ~55–75% of a full re-review. On #992 it missed F-008, a major in code unchanged since round 1 that round 1 (0 findings) had also missed. Decision (owner): add a cheap second look — unchanged code is read once per round by review-logic and review-security-code, and gets full treatment when the previous round was weak (incomplete, unproven coverage, skipped reviewers, narrower scope). This was implemented after the run (lanes l5/l6), so these numbers predate it.

Bugs found by the eval and fixed: merged PRs gave a silently empty range; first-round slices included committed review packages; target identity missed a commit-ref target (now `targetKey`).

Files: `round2-ab-score.json` (final run), `round2-ab-first-attempt.json` (first #1005 attempt).
