# A/B eval: PR #939 (head ede409d5), OLD plan vs NEW plan

Truth: 6 defects (8 entries) later fixed in #988. Both arms ran on Opus with identical reviewer prompts over the same 14 slices (206,547 bytes, no omissions).

| | OLD (9 roles x all slices) | NEW (manifest roles) |
|---|---|---|
| Dispatches | 45 | 27 |
| Findings (major+) | 77 (5) | 44 (5) |
| Approx tokens | 4.44M | 2.74M |
| Wall (sum of batch max) | 1073 s | 1427 s |
| Longest single dispatch | 269 s | 802 s (testing-practices) |
| Truth recall, any (defects / entries) | 2/6 / 4/8 | 2/6 / 3/8 |
| Truth recall, major (defects / entries) | 2/6 / 2/8 | 1/6 / 1/8 |
| Missed | D3, D4, D5, D6 | D2-b, D3, D4, D5, D6 |
| Confirmed major extras | 1 | 1 |

## Truth found
- OLD: D1-a (minor; logic, security x2, style), D1-b (major; logic), D2-a (minor; clean-code), D2-b (major; architecture, logic: preflights hard-code `Agent`, with no host equivalent).
- NEW: D1-a (minor; logic, security), D1-b (major; security), D2-a (minor; clean-code; info from architecture). Nobody in NEW flagged D2-b. The NEW roles for those slices did run, but the architecture finding was about main-session enforcement, and style only flagged formatting.
- Near-miss, not counted: both arms flagged `nextAfterRateLimit` for the missing-retry-after case. The truth (D4) is the unbounded retry-after.

## Confirmed extras (blocker/major not in truth; 2 Opus verifiers)
- OLD architecture-3:0: confirmed major. review-pr-feedback still hands flow-orchestrator to a subagent, and the new preflight blocks that.
- OLD regression-5:0: confirmed, but only minor. `budget --full` and `ingest` record different waves only when `--parallel` is above 10.
- NEW logic-4:0: confirmed major. The new rule that a reply must start with `STATUS:` makes reviewers that return REVIEW_RESULT count as BLOCKED, and their findings are dropped.
- NEW highload-4:0 and logic-1:0: confirmed, but only minor. NEW regression-1:0: refuted, because Wave C was already conditional at base.

## Verdict
- NEW vs OLD on recall-any: tie at 2/6 defects. OLD found one more truth entry (4/8 vs 3/8).
- On recall-major, NEW is worse: 1/6 vs 2/6. NEW lost D2-b.
- Confirmed major extras are tied at 1 each.
- On cost, NEW is about 38% cheaper: 27 vs 45 dispatches, 2.74M vs 4.44M tokens.
- Wall time can't be compared. A shared 20-subagent limit throttled both arms, and NEW had one 802 s outlier.
- Neither arm found D3, D5 or D6 (contradictions in skill prose deep in SKILL.md).
