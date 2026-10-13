# Replay of the closed review rounds (flow 441, AC16)

Old parser = `legacyParseReviewResult` (`parseReviewResult` as of 249bc59b). New parser = `parseReviewResult` in `src/review/ledger.ts`.
Outcome format: `reviewer|status|f=<findings>|reviewer-result=<bool>`; `none` = no result, `empty` = empty output.
Regenerate with `bun src/review/replay.ts --write <path>`. The parser was not tuned to remove any row; every difference awaits an operator decision.

Files replayed: 19. Same: 7. Differences: 12.

| File | sha256[:12] | Old | New | Cause | Decision |
| --- | --- | --- | --- | --- | --- |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round2-d5a8cfdc/raw/review-security-code.txt | b852abf6c599 | none | review-security-code|DONE_WITH_CONCERNS|f=2|reviewer-result=true | fence-inner-backticks | undecided |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round2-d5a8cfdc/raw/review-style.txt | 22d76e0141da | none | review-style|DONE|f=5|reviewer-result=true | fence-inner-backticks | undecided |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round2-d5a8cfdc/raw/review-testing-practices.txt | 8c0f0b344d6d | none | review-testing-practices|DONE_WITH_CONCERNS|f=8|reviewer-result=true | fence-inner-backticks | undecided |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round3-07730d87/raw/review-architecture.txt | 5dce5ec75377 | none | review-architecture|DONE|f=4|reviewer-result=true | fence-inner-backticks | undecided |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round3-07730d87/raw/review-clean-code.txt | ccf906348249 | none | review-clean-code|DONE_WITH_CONCERNS|f=4|reviewer-result=true | fence-inner-backticks | undecided |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round3-07730d87/raw/review-highload.txt | a70379671abb | none | review-highload|DONE_WITH_CONCERNS|f=2|reviewer-result=true | fence-inner-backticks | undecided |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round3-07730d87/raw/review-logic.txt | f086de40ff96 | none | review-logic|DONE_WITH_CONCERNS|f=2|reviewer-result=true | fence-inner-backticks | undecided |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round3-07730d87/raw/review-performance.txt | 38b52f339c27 | none | review-performance|DONE_WITH_CONCERNS|f=2|reviewer-result=true | fence-inner-backticks | undecided |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round3-07730d87/raw/review-security-code.txt | 5ed15ca8cae1 | none | review-security-code|DONE_WITH_CONCERNS|f=1|reviewer-result=true | fence-inner-backticks | undecided |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round3-07730d87/raw/review-style.txt | 47607f71e020 | none | review-style|DONE|f=5|reviewer-result=true | fence-inner-backticks | undecided |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round3-07730d87/raw/review-testing-practices.txt | 7b02605069a1 | none | review-testing-practices|DONE_WITH_CONCERNS|f=3|reviewer-result=true | fence-inner-backticks | undecided |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round3-07730d87/raw/review-verifier.txt | fcbf6b25c7c4 | -|DONE|f=-|reviewer-result=false | none | status-only-fragment | undecided |

## Causes

- `fence-inner-backticks`: the old parser cut a `REVIEW_RESULT` fence at the first triple backtick, even one inside a JSON string, found invalid JSON and returned no result; the new parser reads the whole fence and returns the reviewer result the file holds (F-016).
- `status-only-fragment`: the old parser accepted any object with a string `status`; the file holds a verifier envelope with no reviewer name, which `loadRaws` already ignored as a non-reviewer result. The new parser returns none.
- `unclassified`: a difference neither cause explains; the repository test fails on it.

## Files with the same outcome

- .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round2-d5a8cfdc/raw/review-architecture.txt (234bce95337c): review-architecture|DONE|f=3|reviewer-result=true
- .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round2-d5a8cfdc/raw/review-clean-code.txt (407aee9bc19e): review-clean-code|DONE_WITH_CONCERNS|f=4|reviewer-result=true
- .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round2-d5a8cfdc/raw/review-highload.txt (113522086253): review-highload|DONE|f=3|reviewer-result=true
- .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round2-d5a8cfdc/raw/review-logic.txt (5eb349c3aa76): review-logic|DONE_WITH_CONCERNS|f=5|reviewer-result=true
- .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round2-d5a8cfdc/raw/review-performance.txt (2dd31526abc7): review-performance|DONE_WITH_CONCERNS|f=1|reviewer-result=true
- .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round2-d5a8cfdc/raw/review-regression.txt (9bbb7dcb3ac9): review-regression|DONE_WITH_CONCERNS|f=1|reviewer-result=true
- .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round3-07730d87/raw/review-regression.txt (b7a7e1ac6093): review-regression|DONE|f=0|reviewer-result=true
