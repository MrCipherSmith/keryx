# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The directory `docs/research/role-blurring-part1/` holds `README.md`, `protocol-part2.md`, `part1-counts.py`, `part1-counts.json`, `contribution-log.md` and `decisions-export-2026-10-04.jsonl`, and nothing else except the one-off export script when `keryx decisions export` is not available. [verify: exec `bun test src/docs/part1-materials.test.ts`]
- AC2: `part1-counts.py` is the attached file byte for byte, and `part1-counts.json` is its output run from the repository root at the commit recorded in the README. The README gives that commit hash, the run command, and says the snapshot is the state of `.metaproject/flows/` at that commit. Re-running at that commit reproduces the file except `generated_at`. [verify: judged]
- AC3: Every number in the operator's list (383 units, 3175 criteria, 3062 confirmed, 159 units over 368 rounds, 2544 findings with 1967 verdicts: 1623 refuted, 329 confirmed, 15 unverifiable, 577 without verdict, of the refuted 1546 acted-on, 49 dismissed-incorrect, 28 without a decision, 175 blocking, 44 units after 28 September, outcomeAuthor agent 18 and human 11, origin human-request 9 and agent-finding 1) either matches `part1-counts.json` or the README lists the number, the value found, and the likely cause. The script is not edited to fit the article. [verify: judged]
- AC4: `protocol-part2.md` equals the operator's attached `protocol-part2-v2.md` byte for byte (version 2, fixed 2026-10-04, which corrects the P1 support condition of version 1 and keeps the version table with both rows); the test checks its SHA-256. [verify: exec `bun test src/docs/part1-materials.test.ts`]
- AC5: Every row of `contribution-log.md` has the form `YYYY-MM-DD · source · «verbatim quote» · what changed in the article`, and the quote is found verbatim in the named source (a channel message id, or the operator's export of the article draft comment threads, `draft-comments-export.md`, supplied 2026-10-04). A row without a findable quote is not written, and a row whose quote would reveal the operator's employer, team repositories or working hours is held back and listed by number in the flow journal for the operator to decide. [verify: judged]
- AC6: `decisions-export-2026-10-04.jsonl` covers the recommendation journal for 2 to 4 October, and no record carries question text, option text, reason text or an own answer; the test checks the field names against an allow-list (identifiers, mode, order, preselection, match, time to answer, whether a reason exists). The README marks these as pilot records outside the confirmatory sample of part 2. [verify: exec `bun test src/docs/part1-materials.test.ts`]
- AC7: No file in the directory mentions the operator's team repositories: a case-insensitive search for `frontend`, `backend`, `board`, `process-metrics` finds nothing in the new files (the attached originals give zero matches today), and the result of the search is written to the flow journal. [verify: exec `bun test src/docs/part1-materials.test.ts`]
- AC8: `README.md` is in English with a Russian title line, gives the article title in both languages, the status "preprint, part 1", the snapshot date, a placeholder for the article link, one line per file, and one URL form that can be pasted into the article. [verify: judged]
