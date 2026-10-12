# Review of PR #875 (flow 400), head 46f49243

The diff was read at the head SHA: the arm assignment and seeding (arms.ts, journal.ts), the presentation and reveal (ask.ts, ask_user description, composer-choice, the picker bridge), the export allow-list and the report, the quality matrix and the blind-model call, and the decisions command. Arm assignment is a pure function of the salt and the position, an irreversible question is forced to arm A, eligible is the complement of forced, the export carries no text, and the blind prompt is scrubbed with the same function as arm D. Three defects were found, all small.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/decisions/journal.ts",
    "line": 58,
    "problem": "findOpenTwin matches any still-unanswered open record with the same question hash, with no age or session bound, so an old unanswered open (a crashed or abandoned session) is reused by a later identical question.",
    "impact": "The new question inherits the old id, arm and seed, and timeToAnswerMs is measured from the old open.at, which inflates the median time to answer and pins one question to one arm forever.",
    "suggested_fix": "Bound the twin lookup to the same session and a short window, or close an open that was never answered when its session ends.",
    "evidence": "openDecision calls findOpenTwin over readRecords(cwd) and returns resultOf(twin); answerDecision computes now - Date.parse(open.at).",
    "confidence": "medium"
  },
  {
    "id": "F-002",
    "reviewer": "review-highload",
    "severity": "minor",
    "file": "src/decisions/journal.ts",
    "line": 106,
    "problem": "seq is computed from an unlocked read (records.filter(open).length + 1), so two opens racing in two processes can read the same count and take the same seq.",
    "impact": "Both get the same seed and therefore the same arm and the same reason-subsample draw, which breaks the independence of the randomisation for concurrent questions.",
    "suggested_fix": "Compute seq inside the journal lock that appendRecord takes, or derive the seed from the decision id as well as the seq.",
    "evidence": "seq = input.seq ?? records.filter((r) => r.kind === 'open').length + 1, read before appendRecord.",
    "confidence": "medium"
  },
  {
    "id": "F-003",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/decisions/export.ts",
    "line": 131,
    "problem": "ISO_UTC accepted only a trailing Z, so a record whose timestamp carried a numeric UTC offset was exported with openedAt null.",
    "impact": "decisions export --since dropped such records as unreadable (47 records without the window, 37 with it).",
    "suggested_fix": "Parse the offset form and write it in UTC.",
    "evidence": "Fixed after the merge: toUtcIso now accepts ISO_OFFSET and normalises it.",
    "confidence": "high"
  }
]
```
