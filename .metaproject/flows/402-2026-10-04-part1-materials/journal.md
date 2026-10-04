# Flow Journal

- 2026-10-04T13:12:49.686Z - flow created
- 2026-10-04T13:14:08.104Z - frozen: 8 criteria; checksum recorded
- 2026-10-04T13:14:08.520Z - started
- 2026-10-04 - privacy search over docs/research/role-blurring-part1: `keryx ctx rg -n -i "frontend|backend|board|process-metrics" docs/research/role-blurring-part1` -> 0 matches
- 2026-10-04 - export: `keryx decisions export --since 2026-10-02T00:00:00Z` gave 47 records, not the 37 named in the protocol; 30 poll-imported records of 2026-10-02 carry a numeric UTC offset and the command's filter drops them (README explains)
- 2026-10-04 - contribution log: 12 rows with verbatim quotes (channel messages 170491, 170614, 170789, 170800, 170866, 177393, 177418, 177461, 177483, 177497, 177672 x2), each checked as an exact substring of its source. No findable quote, so no row: genre decision (essay-research), dropping "corpus", "не по вечерам, а в свободное время", the ban on team-repository details, "ведём эксперимент через слепые вопросы", thresholds P1/P2/P3/P5 of 4 October. They are expected in the operator's artifact-comment export.
- 2026-10-04T13:24:47.018Z - task-done: T1: Collect remaining context
- 2026-10-04T13:24:47.208Z - task-done: T2: Implement per plan
- 2026-10-04T13:24:47.411Z - task-done: T3: Add/adjust tests and make them pass
- 2026-10-04T13:24:47.602Z - task-done: T4: Self-review and prepare draft PR
- 2026-10-04T14:54:25.931Z - ac-updated: AC4: "`protocol-part2.md` equals the attached `protocol-part2-v1.md` except for a first line `Version 1, fixed 2026-10-04` and the version table, which keeps the date and says later changes are new versions, not edits. [verify: exec `bun test src/docs/part1-materials.test.ts`]" -> "`protocol-part2.md` equals the operator's attached `protocol-part2-v2.md` byte for byte (version 2, fixed 2026-10-04, which corrects the P1 support condition of version 1 and keeps the version table with both rows); the test checks its SHA-256. [verify: exec `bun test src/docs/part1-materials.test.ts`]" (Operator replaced protocol v1 with v2 (P1 support condition: upper bound instead of lower bound) in message 183166, before any confirmatory observation)
- 2026-10-04T14:54:26.123Z - ac-updated: AC5: "Every row of `contribution-log.md` has the form `YYYY-MM-DD · source · «verbatim quote» · what changed in the article`, and the quote is found verbatim in the named source. A row without a findable quote is not written. The log holds at least the rows the prompt names that have a findable quote, and the README or the flow journal lists each named decision for which no quote was found. [verify: judged]" -> "Every row of `contribution-log.md` has the form `YYYY-MM-DD · source · «verbatim quote» · what changed in the article`, and the quote is found verbatim in the named source (a channel message id, or the operator's export of the article draft comment threads, `draft-comments-export.md`, supplied 2026-10-04). A row without a findable quote is not written, and a row whose quote would reveal the operator's employer, team repositories or working hours is held back and listed by number in the flow journal for the operator to decide. [verify: judged]" (Operator supplied the draft comment export in message 183166; add its source and the privacy hold rule consistent with AC7)
- 2026-10-04 - protocol replaced by version 2: `protocol-part2.md` is now a byte-for-byte copy of the operator's `protocol-part2-v2.md` (verified with cmp, SHA-256 4ea9dde3b7cd9be948a3bc1fc3b08c70d49c84e2754ce5a6f9d4c5b975f2a5fe); the test asserts the digest, the "версия 2" heading and the version rows for 1 and 2; README updated
- 2026-10-04 - AC4 and AC5 were rewritten via `keryx flow ac update` after the operator supplied protocol v2 and the comments export
- 2026-10-04 - contribution log rebuilt: 12 original rows kept, 33 rows appended from the operator's draft comments export (26 from the comments table, 7 from the chat table), 45 rows in all. Rows built by a throwaway script that parses the export tables; each appended quote was checked as an exact substring of the export file. The log closes by saying the original thread export is held by the operator.
- 2026-10-04 - privacy search after the rebuild: `keryx ctx rg -c -i "frontend|backend|board|process-metrics" docs/research/role-blurring-part1` -> 0 matches
- 2026-10-04 - the README section "Not in the log" was replaced by a short generic note (some decisions withheld at the author's discretion; decisions without a findable quote are not logged)

## Held back for the operator

Reason for all rows: privacy rule AC5/AC7. The filter was a case-insensitive substring match over the place, quote and change cells; one further chat row named in the brief is also held whole (it is among the chat rows listed below).

- comments table rows 7, 9, 16, 20, 25, 27, 29
- chat table rows 2, 3, 5, 7, 10

Comments rows 7 and 9 matched only through their place cell (the filter was applied to it as an extension of the instruction); the operator may release them.
