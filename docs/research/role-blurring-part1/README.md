«Размытие ролей в продуктовой разработке в условиях агентной автоматизации: концепция остаточного суждения»

# Role Blurring in Product Development under Agentic Automation: the Residual Judgment Concept

Status: preprint, part 1.
Article: link to be added when the article is published.
Link for the article: https://github.com/MrCipherSmith/keryx/tree/main/docs/research/role-blurring-part1

This directory holds the materials behind part 1: the counts over the committed flow records, the protocol that fixes how part 2 will be tested, the log of decisions that changed the direction of the article, and a text-free export of the pilot recommendation records.

## Snapshot

- Snapshot date: 2026-10-04.
- Snapshot commit: `04809f4f`.
- The snapshot is the committed state of `.metaproject/flows/` at that commit. It is not copied here. Flow folders that exist only in a working copy and were never committed are not part of any commit and are not in the snapshot.
- To reproduce the counts, check out the snapshot commit and run, from the repository root:

```bash
git checkout 04809f4f
python3 docs/research/role-blurring-part1/part1-counts.py
```

The script reads only `.metaproject/flows/*` and writes `part1-counts.json` to the current directory. Run from the repository root at the snapshot commit it overwrites the committed `part1-counts.json` with the same counts (only the `generated_at` field differs).

## Files

- `README.md`: this file.
- `protocol-part2.md`: the protocol for part 2, version 1, fixed 2026-10-04. Later changes are made as a new version with a new row in its version table, not as an edit of the text.
- `part1-counts.py`: the counting script, unchanged.
- `part1-counts.json`: the script output at `04809f4f`.
- `contribution-log.md`: dated operator decisions that changed the direction of the article, with verbatim quotes.
- `decisions-export-2026-10-04.jsonl`: the recommendation journal exported without text, produced by `keryx decisions export --since 2026-10-02T00:00:00Z`.

## Counts at the snapshot

No discrepancy with the article at `04809f4f`: 383 units of work, 3175 criteria, 3062 confirmed, 44 units since the baseline, outcome author agent 18 and human 11, origin human-request 9 and agent-finding 1, 159 reviewed units over 368 rounds, 2544 findings (175 blocking), verdicts 1623 refuted, 329 confirmed, 15 unverifiable, 577 without a verdict, and of the refuted 1546 acted-on, 49 dismissed-incorrect, 28 without a decision.

On the current main (`2952a6e0`) the same script gives 385 units, 3209 criteria, 3050 confirmed, 46 since the baseline, 13 human and origin human-request 11, with the review numbers unchanged. This is expected drift, not a discrepancy: flow 389's confirmations were voided after the snapshot.

## Pilot records

`decisions-export-2026-10-04.jsonl` holds 47 records of the recommendation journal from 2026-10-02 onward. They are pilot records and are outside the confirmatory sample of part 2.

The export carries only identifiers, mode, order, preselection, match, time to answer and whether a reason was given. It has no question text, option text, reason text or typed answer.

The count differs from the 37 decisions named in the protocol. The export command filters on timestamps in UTC `Z` form; 30 records that were imported from earlier polls on 2026-10-02 carry a numeric offset instead and are left out by the filter. The 47 are what the command produces, and no record was added or removed by hand.

## Protocol version

`protocol-part2.md` is version 1. Its text is the original protocol with one added first line giving the version and date, and one added closing note about how versions are changed.

## Not in the log

These decisions are named in the brief for the log but have no verbatim quote in the sources that were available, so no row is written for them:

- the genre decision (essay-research);
- dropping the word "corpus";
- «не по вечерам, а в свободное время»;
- the ban on details about team repositories (the log may only say that such a ban exists);
- «ведём эксперимент через слепые вопросы»;
- the choice of thresholds P1, P2, P3 and P5 on 4 October.

Their quotes are expected in the operator's artifact-comment export, and rows will be added when it is supplied.
