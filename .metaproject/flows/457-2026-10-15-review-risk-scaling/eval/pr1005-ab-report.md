# A/B review eval: PR #1005 round 1 (c75f0091)

Diff `input.round1-c75f0091.diff` (18 KB, 11 files) sliced once into 2 slices / 1 wave (slice-01 deep, 7 roles; slice-02 light, logic + testing). Truth: F-057, F-058, F-061 (all major). Same model (Opus), same reviewer prompt in both arms.

| | OLD (9 roles x all slices) | NEW (manifest roles) |
|---|---|---|
| Dispatches | 9 | 7 |
| Approx tokens | 780,855 | 631,459 |
| Wall time (ideal parallel, max) | 76s | 181s |
| Agent time (sum) | 417s | 505s |
| Truth found (any) | 2/3 (F-057, F-061) | 2/3 (F-057, F-061) |
| Truth found (major/blocker) | 1/3 (F-057) | 1/3 (F-057) |
| Missed | F-058 | F-058 |
| Confirmed extras (major+) | 0 | 0 |

## Matches
- F-057 (sibling git revision sites unguarded): OLD by logic, security-code, architecture (all major); NEW by logic, security-code (both major). NEW's security finding also named review.ts:976 -> resolveIngestDiff and more sibling sites.
- F-061 (tests leave guarantees unpinned): both arms found it at minor only (jev rows return early when Jev is disabled; source-count pin). Severity under-called in both.
- F-058 (backslash/brace/$ spellings of --output evading EXEC_FLAGS): missed by both. Closest were minor/info notes that hasDashValue only applies to `review`.

## Extras
No blocker/major finding outside truth in either arm: every major is the F-057 class. The verifier pool was empty, so no verifier ran.
NEW-only minors of note: glued stdin sentinel `--diff=-` now prompts (regression RR-001); fixture inherits global git hooks (TP-2); `--end-of-options` needs git >= 2.24 (logic F-004).

## Verdict
- Recall-any: tie (2/3 vs 2/3). Recall-major: tie (1/3 vs 1/3). Confirmed extras: tie (0 vs 0).
- Cost: NEW used 7 dispatches vs 9 (-22%) and 631,459 tokens vs 780,855 (-19%). Dropping performance and style lost nothing; they produced only minor/info.
- Caveat: a shared 20-agent concurrency cap forced batches of 2-4, so wall time is the slowest single dispatch. NEW's testing-practices took 181s, which on this run makes NEW slower than OLD's 76s. Treat that as noise from one reviewer, not a property of the plan.
