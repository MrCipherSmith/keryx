# Replay of the closed review rounds (flow 441, AC16)

Old parser = `legacyParseReviewResult` (`parseReviewResult` as of 249bc59b). New parser = `parseReviewResult` in `src/review/ledger.ts`.
Outcome format: `reviewer|status|f=<findings>|reviewer-result=<bool>`; `none` = no result, `empty` = empty output.
Regenerate with `bun src/review/replay.ts --write .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/replay-report.md` (from the repository root). The parser was not tuned to remove any row; each difference carries the operator decision recorded for that file and hash in `DECISIONS`, or `undecided`.

Replayed: files named `*.txt` whose parent directory is `raw`, under `.metaproject/flows`, with no `raw`, `drivers`, `research-evidence` or `node_modules` directory above that `raw`. Where the replayed root holds a `.git` entry, only the files git tracks are listed (`git ls-files`; a git failure there is an error, not a reason to walk). Where it does not, the directory is walked instead. Only regular files are read. A path that resolves through a symbolic link, a tracked file missing from the working tree and a tracked path that is no longer a regular file are skipped. `.metaproject/data/**/raw/` is gitignored local working state and is not replayed. The PR 992 round 3 package (`.metaproject/reviews/2026-10-13-pr-992-round3-d20089aa/`) has no `raw/` directory on main, so its nine replies are not part of this replay.

Files replayed: 45. Same: 33. Differences: 12.

| File | sha256[:12] | Old | New | Cause | Decision |
| --- | --- | --- | --- | --- | --- |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round2-d5a8cfdc/raw/review-security-code.txt | b852abf6c599 | none | review-security-code\|DONE_WITH_CONCERNS\|f=2\|reviewer-result=true | fence-inner-backticks | accepted (operator, poll 161, 2026-10-13) |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round2-d5a8cfdc/raw/review-style.txt | 22d76e0141da | none | review-style\|DONE\|f=5\|reviewer-result=true | fence-inner-backticks | accepted (operator, poll 161, 2026-10-13) |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round2-d5a8cfdc/raw/review-testing-practices.txt | 8c0f0b344d6d | none | review-testing-practices\|DONE_WITH_CONCERNS\|f=8\|reviewer-result=true | fence-inner-backticks | accepted (operator, poll 161, 2026-10-13) |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round3-07730d87/raw/review-architecture.txt | 5dce5ec75377 | none | review-architecture\|DONE\|f=4\|reviewer-result=true | fence-inner-backticks | accepted (operator, poll 161, 2026-10-13) |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round3-07730d87/raw/review-clean-code.txt | ccf906348249 | none | review-clean-code\|DONE_WITH_CONCERNS\|f=4\|reviewer-result=true | fence-inner-backticks | accepted (operator, poll 161, 2026-10-13) |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round3-07730d87/raw/review-highload.txt | a70379671abb | none | review-highload\|DONE_WITH_CONCERNS\|f=2\|reviewer-result=true | fence-inner-backticks | accepted (operator, poll 161, 2026-10-13) |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round3-07730d87/raw/review-logic.txt | f086de40ff96 | none | review-logic\|DONE_WITH_CONCERNS\|f=2\|reviewer-result=true | fence-inner-backticks | accepted (operator, poll 161, 2026-10-13) |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round3-07730d87/raw/review-performance.txt | 38b52f339c27 | none | review-performance\|DONE_WITH_CONCERNS\|f=2\|reviewer-result=true | fence-inner-backticks | accepted (operator, poll 161, 2026-10-13) |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round3-07730d87/raw/review-security-code.txt | 5ed15ca8cae1 | none | review-security-code\|DONE_WITH_CONCERNS\|f=1\|reviewer-result=true | fence-inner-backticks | accepted (operator, poll 161, 2026-10-13) |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round3-07730d87/raw/review-style.txt | 47607f71e020 | none | review-style\|DONE\|f=5\|reviewer-result=true | fence-inner-backticks | accepted (operator, poll 161, 2026-10-13) |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round3-07730d87/raw/review-testing-practices.txt | 7b02605069a1 | none | review-testing-practices\|DONE_WITH_CONCERNS\|f=3\|reviewer-result=true | fence-inner-backticks | accepted (operator, poll 161, 2026-10-13) |
| .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round3-07730d87/raw/review-verifier.txt | fcbf6b25c7c4 | -\|DONE\|f=-\|reviewer-result=false | none | status-only-fragment | accepted (operator, polls 162 and 163, 2026-10-13) |

## Causes

- `fence-inner-backticks`: the old parser cut a `REVIEW_RESULT` fence at the first triple backtick, even one inside a JSON string, found invalid JSON and returned no result; the new parser reads the whole fence and returns the reviewer result the file holds (finding F-016 of the PR 997 round 2 package, `2026-10-13-pr-997-round2-d5a8cfdc`).
- `status-only-fragment`: the old parser accepted any object with a string `status`; the file holds a verifier envelope with no reviewer name; the new parser returns none, so `loadRaws` keeps the file with no result and `ledger build` records one gap for it, "no parseable REVIEW_RESULT block". Accepted by the operator in polls 162 and 163.
- `unclassified`: a difference neither cause explains; the repository test fails on it.
- Any difference, whatever its cause, is `undecided` until `DECISIONS` lists its file and hash; the repository test fails on `undecided`.

## Files with the same outcome

- .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round2-d5a8cfdc/raw/review-architecture.txt (234bce95337c): review-architecture\|DONE\|f=3\|reviewer-result=true
- .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round2-d5a8cfdc/raw/review-clean-code.txt (407aee9bc19e): review-clean-code\|DONE_WITH_CONCERNS\|f=4\|reviewer-result=true
- .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round2-d5a8cfdc/raw/review-highload.txt (113522086253): review-highload\|DONE\|f=3\|reviewer-result=true
- .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round2-d5a8cfdc/raw/review-logic.txt (5eb349c3aa76): review-logic\|DONE_WITH_CONCERNS\|f=5\|reviewer-result=true
- .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round2-d5a8cfdc/raw/review-performance.txt (2dd31526abc7): review-performance\|DONE_WITH_CONCERNS\|f=1\|reviewer-result=true
- .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round2-d5a8cfdc/raw/review-regression.txt (9bbb7dcb3ac9): review-regression\|DONE_WITH_CONCERNS\|f=1\|reviewer-result=true
- .metaproject/flows/441-2026-10-13-deferred-majors-of-pr-940-and-pr-975/reviews/2026-10-13-pr-997-round3-07730d87/raw/review-regression.txt (b7a7e1ac6093): review-regression\|DONE\|f=0\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-architecture-w1.txt (50bb4a31f759): review-architecture\|DONE\|f=1\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-architecture-w2.txt (f490014dfd94): review-architecture\|DONE\|f=5\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-architecture-w3.txt (a873bd459d84): review-architecture\|DONE\|f=8\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-clean-code-w1.txt (fb34415d2219): review-clean-code\|DONE\|f=5\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-clean-code-w2.txt (50844802d4e9): review-clean-code\|DONE_WITH_CONCERNS\|f=13\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-highload-w1.txt (acfebafb399f): review-highload\|DONE\|f=1\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-highload-w2.txt (f4b6271f5276): review-highload\|DONE\|f=3\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-logic-w1.txt (171874222f95): review-logic\|DONE\|f=2\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-logic-w2.txt (fdce45ef7ca2): review-logic\|DONE\|f=1\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-logic-w3.txt (92f65f289e94): review-logic\|DONE\|f=6\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-logic-w4.txt (433626b69eb2): review-logic\|DONE\|f=3\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-performance-w1.txt (6c5c6a768478): review-performance\|DONE\|f=1\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-performance-w2.txt (2270f331998a): review-performance\|DONE\|f=4\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-pr-contract-w1.txt (6da6960f9292): review-pr-contract\|DONE\|f=7\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-pr-contract-w2.txt (28d0bb90f2a4): review-pr-contract\|DONE_WITH_CONCERNS\|f=3\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-pr-contract-w3.txt (893d7e7700f4): review-pr-contract\|DONE_WITH_CONCERNS\|f=3\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-pr-contract-w4.txt (2602570cc7e2): review-pr-contract\|DONE_WITH_CONCERNS\|f=2\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-regression-w1.txt (2d63a155d435): review-regression\|DONE\|f=0\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-regression-w2.txt (8d1b813f3686): review-regression\|DONE_WITH_CONCERNS\|f=1\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-security-code-w1.txt (6c4d3dd35f13): review-security-code\|DONE\|f=0\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-security-code-w2.txt (ac3789355820): review-security-code\|DONE\|f=2\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-style-w1.txt (e1b73364be1e): review-style\|DONE\|f=3\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-style-w2.txt (0cf31873aa71): review-style\|DONE\|f=6\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-style-w3.txt (132d3cf72fdd): review-style\|DONE\|f=15\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-testing-practices-w1.txt (3c2e687362c1): review-testing-practices\|DONE_WITH_CONCERNS\|f=1\|reviewer-result=true
- .metaproject/flows/471-2026-10-22-connect-providers-tabs/reviews/2026-10-22-pr-1074-ingest-r2/raw/review-testing-practices-w2.txt (b8e94e51d9b6): review-testing-practices\|DONE_WITH_CONCERNS\|f=8\|reviewer-result=true
