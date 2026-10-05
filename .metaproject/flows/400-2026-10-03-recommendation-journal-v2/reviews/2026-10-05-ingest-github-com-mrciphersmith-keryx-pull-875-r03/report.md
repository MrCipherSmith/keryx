# Re-review of PR #875 (flow 400) at merge commit 2b537de0

Findings F-001, F-002 and F-003 of rounds r02 and the first-draft round are re-raised under their original identity so the gate can record that each is fixed. The fixes were checked in a clean extract of 2b537de0 by running the decisions tests (32 pass) and reading the fixed sites.

```json keryx:findings
[
  {
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/decisions/journal.ts",
    "problem": "findOpenTwin matches any still-unanswered open record with the same question hash, with no age or session bound, so an old unanswered open (a crashed or abandoned session) is reused by a later identical question.",
    "impact": "The new question inherits the old id, arm and seed, and timeToAnswerMs is measured from the old open.at, which inflates the median time to answer and pins one question to one arm forever.",
    "suggested_fix": "Bound the twin lookup to the same session and a short window, or close an open that was never answered when its session ends.",
    "confidence": "medium",
    "id": "F-001",
    "line": 58,
    "global_id": "2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-875-r02#F-001",
    "evidence": "Fixed in d55650ec (PR 893, merged 2b537de0): twin lookup bounded to the same session and OPEN_TWIN_MAX_AGE_MS (1 hour)."
  },
  {
    "reviewer": "review-highload",
    "severity": "minor",
    "file": "src/decisions/journal.ts",
    "problem": "seq is computed from an unlocked read (records.filter(open).length + 1), so two opens racing in two processes can read the same count and take the same seq.",
    "impact": "Both get the same seed and therefore the same arm and the same reason-subsample draw, which breaks the independence of the randomisation for concurrent questions.",
    "suggested_fix": "Compute seq inside the journal lock that appendRecord takes, or derive the seed from the decision id as well as the seq.",
    "confidence": "medium",
    "id": "F-002",
    "line": 100,
    "global_id": "2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-875-r02#F-002",
    "evidence": "Fixed in d55650ec (PR 893, merged 2b537de0): twin lookup, seq allocation and append run under withJournalLock."
  },
  {
    "reviewer": "review-highload",
    "severity": "minor",
    "file": "src/decisions/journal.ts",
    "problem": "seq is computed from an unlocked read (records.filter(open).length + 1), so two opens racing in two processes can read the same count and take the same seq.",
    "impact": "Both get the same seed and therefore the same arm and the same reason-subsample draw, which breaks the independence of the randomisation for concurrent questions.",
    "suggested_fix": "Compute seq inside the journal lock that appendRecord takes, or derive the seed from the decision id as well as the seq.",
    "confidence": "medium",
    "id": "F-002b",
    "line": 106,
    "global_id": "2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-875#F-002",
    "evidence": "Fixed in d55650ec (PR 893, merged 2b537de0): twin lookup, seq allocation and append run under withJournalLock."
  },
  {
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/decisions/export.ts",
    "problem": "ISO_UTC accepted only a trailing Z, so a record whose timestamp carried a numeric UTC offset was exported with openedAt null.",
    "impact": "decisions export --since dropped such records as unreadable (47 records without the window, 37 with it).",
    "suggested_fix": "Parse the offset form and write it in UTC.",
    "confidence": "high",
    "id": "F-003",
    "line": 131,
    "global_id": "2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-875-r02#F-003",
    "evidence": "Fixed in b59fb36a (ancestor of 2b537de0): toUtcIso accepts ISO_OFFSET and normalises to UTC."
  }
]
```
