# F-006: cost of the outdated lookup in `DeskRunStore.attachBadges`

Measured 2026-11-23 on macOS (Darwin 25.6.0), bun 1.4.4, SQLite 3.51.0 (bun's bundled build).

## Setup

- Script: `/private/tmp/claude-502/-Users-tsaitler-aleksandr-work-sandbox-keryx/16eb71ab-3482-424e-a8e9-860429a53c0f/scratchpad/measure.ts` (throwaway, outside the repository).
- Store built with the real `DeskRunStore` API (`request` + `queued` + `end`, as `desk-run-store.test.ts` does):
  200 pull requests x 30 finished runs (every third `partial`, the rest `completed`), each run on its own head and with a
  200 KB report in `result.report`; every tenth PR also has a `queued` run on the card's new head. File size 1.2 GB;
  build took 13.0 s.
- `attachBadges` called on one 200-card batch (PR 1..200), opened read-only as `readLocalBadges` does. Each figure is
  over 5 calls after 1 warm-up call. Scenarios:
  - `current`: every card is on the newest reviewed range (ready; the outdated value is discarded).
  - `newHead`: every card is on an unreviewed head (outdated used, except the 20 PRs with an active run).
  - `mixed`: alternating.
- Versions: `base` = `1b994df18` statement (no outdated lookup); `head` = `53c96b8af` (materialized `wanted` CTE with a
  correlated subquery per card); `after` = this change. Badge output is hashed (sha256 of the cards JSON, first 16 hex).

## Timings (ms, 200-card batch)

| version | current median (min-max) | newHead median (min-max) | mixed median (min-max) |
|---|---|---|---|
| base, run 1 | 386.8 (384.5-400.8) | 392.3 (385.8-397.4) | 407.2 (396.0-423.0) |
| base, run 2 | 405.0 (385.3-429.5) | 401.2 (393.4-411.0) | 411.0 (403.0-449.9) |
| head, run 1 | 774.8 (753.6-849.2) | 839.8 (814.3-868.8) | 806.7 (791.7-953.2) |
| head, run 2 | 771.1 (748.3-794.5) | 741.1 (739.5-757.0) | 744.8 (742.2-776.3) |
| after, run 1 | 474.1 (425.8-502.8) | 449.8 (418.9-507.1) | 469.3 (438.1-518.0) |
| after, run 2 | 395.3 (390.6-408.0) | 398.9 (397.8-400.0) | 401.8 (390.5-412.8) |

Run 1 of `after` ran alone right after editing; run 2 ran back to back with base and head, which is the fairer comparison.

Badge digests: `current` 3087d39546a5699d for base, head and after. `newHead` 16e44518e349589b and `mixed`
8119f994f1c66572 for head and after (identical output); base differs there (72fcfc375efd0633, 8b40a32a0102b25a)
because it has no outdated badge.

Reading: the head statement roughly doubled the cost over base (about +350-400 ms per 200 cards at this size), because
the outdated subquery parsed every run's `details` (which embeds the report) a second time, and did so even for cards
where `localBadge` discards it. The rewrite parses each run once and is back at base cost while returning the same badges.

## EXPLAIN QUERY PLAN (id|parent|detail)

### base (`1b994df18`)

```
5|0|SCAN wanted VIRTUAL TABLE INDEX 1:
10|0|SEARCH r USING INDEX review_history (repo=? AND viewer=? AND pr=?)
81|0|CORRELATED SCALAR SUBQUERY 1
86|81|SEARCH q USING INDEX sqlite_autoindex_review_questions_1 (run_id=?)
98|0|CORRELATED SCALAR SUBQUERY 2
103|98|SEARCH q USING INDEX sqlite_autoindex_reviewer_questions_1 (run_id=?)
148|0|CORRELATED SCALAR SUBQUERY 4
151|148|CO-ROUTINE (subquery-3)
154|151|CO-ROUTINE (subquery-6)
157|154|SCAN s VIRTUAL TABLE INDEX 3:
172|154|USE TEMP B-TREE FOR ORDER BY
189|151|SCAN (subquery-6)
236|148|SCAN (subquery-3)
259|0|USE TEMP B-TREE FOR ORDER BY
```

### head (`53c96b8af`)

```
3|0|MATERIALIZE wanted
6|3|SCAN json_each VIRTUAL TABLE INDEX 1:
21|3|CORRELATED SCALAR SUBQUERY 1
31|21|SEARCH o USING INDEX review_history (repo=? AND viewer=? AND pr=?)
103|21|USE TEMP B-TREE FOR ORDER BY
119|0|SCAN wanted
121|0|SEARCH r USING INDEX review_history (repo=? AND viewer=? AND pr=?)
190|0|CORRELATED SCALAR SUBQUERY 4
195|190|SEARCH q USING INDEX sqlite_autoindex_review_questions_1 (run_id=?)
207|0|CORRELATED SCALAR SUBQUERY 5
212|207|SEARCH q USING INDEX sqlite_autoindex_reviewer_questions_1 (run_id=?)
257|0|CORRELATED SCALAR SUBQUERY 7
260|257|CO-ROUTINE (subquery-6)
263|260|CO-ROUTINE (subquery-9)
266|263|SCAN s VIRTUAL TABLE INDEX 3:
281|263|USE TEMP B-TREE FOR ORDER BY
298|260|SCAN (subquery-9)
345|257|SCAN (subquery-6)
368|0|USE TEMP B-TREE FOR ORDER BY
```

### after (this change)

```
2|0|CO-ROUTINE picked
5|2|CO-ROUTINE (subquery-10)
8|5|CO-ROUTINE (subquery-11)
11|8|MATERIALIZE scoped
16|11|SCAN json_each VIRTUAL TABLE INDEX 1:
21|11|SEARCH r USING INDEX review_history (repo=? AND viewer=? AND pr=?)
89|8|SCAN r
302|8|USE TEMP B-TREE FOR ORDER BY
325|5|SCAN (subquery-11)
386|2|SCAN (subquery-10)
457|0|SCAN p
462|0|SEARCH r USING INTEGER PRIMARY KEY (rowid=?)
470|0|CORRELATED SCALAR SUBQUERY 5
475|470|SEARCH q USING INDEX sqlite_autoindex_review_questions_1 (run_id=?)
487|0|CORRELATED SCALAR SUBQUERY 6
492|487|SEARCH q USING INDEX sqlite_autoindex_reviewer_questions_1 (run_id=?)
537|0|CORRELATED SCALAR SUBQUERY 8
540|537|CO-ROUTINE (subquery-7)
543|540|CO-ROUTINE (subquery-12)
546|543|SCAN s VIRTUAL TABLE INDEX 3:
561|543|USE TEMP B-TREE FOR ORDER BY
578|540|SCAN (subquery-12)
625|537|SCAN (subquery-7)
646|0|USE TEMP B-TREE FOR ORDER BY
```

("SCAN r" at id 89 is the scan of the materialized `scoped` rows, aliased `r` in `flagged`, not of the `runs` table.)

## Limits

- One machine, warm page cache, one data shape. No cold-cache or concurrent-writer timing.
- The F-010 case (a reviewed head without a reviewed base) is not in the synthetic data; its fix is by reading only.
