# PR #800 review (flow367-pr800-review)

No blocker. One major, two minor. The review was static.

```json keryx:findings
[
 {
  "id": "F-001",
  "reviewer": "flow367-pr800-review",
  "severity": "major",
  "problem": "After a history or both rewind, manifest entries taken later keep an archiveIndex from the discarded timeline; a regrown archive lets a later rewind cut the conversation at the wrong message.",
  "impact": "A rewind to a later snapshot passes the range and role checks and cuts history at the wrong user message with no warning.",
  "suggested_fix": "After a successful history rewind, make every later entry file-only.",
  "evidence": "the reviewer read apply.ts, history.ts and recorder.ts; not run",
  "confidence": "high",
  "file": "src/rewind/apply.ts",
  "quote": "historyRewound = true",
  "class_scope": {
   "sites": [
    "src/rewind/apply.ts"
   ],
   "enumeration_method": "the reviewer read the changed files; static review, tests not run by the reviewer"
  },
  "line": 71
 },
 {
  "id": "F-002",
  "reviewer": "flow367-pr800-review",
  "severity": "minor",
  "problem": "The task-notification wake turn does not call beginTurn, so its writes are folded into the previous turn's snapshot or not snapshotted.",
  "impact": "Rewinding to a later snapshot cannot undo files a wake turn wrote; only rewinding to the earlier turn does.",
  "suggested_fix": "Give the wake turn its own snapshot.",
  "evidence": "the reviewer read shell.ts; not run",
  "confidence": "medium",
  "file": "src/commands/shell.ts",
  "quote": "task-notification wake turn",
  "class_scope": {
   "sites": [
    "src/commands/shell.ts"
   ],
   "enumeration_method": "the reviewer read the changed files; static review, tests not run by the reviewer"
  },
  "line": 2568
 },
 {
  "id": "F-003",
  "reviewer": "flow367-pr800-review",
  "severity": "minor",
  "problem": "A file small when first indexed that later grows past 5 MB is skipped, so the tree keeps the stale blob and a rewind overwrites the large file.",
  "impact": "A restore can overwrite a file that grew past the size limit between snapshots.",
  "suggested_fix": "Drop the path from the index when it is skipped as oversized.",
  "evidence": "the reviewer read snapshot.ts; low confidence, not run",
  "confidence": "medium",
  "file": "src/rewind/snapshot.ts",
  "quote": "captureTree",
  "class_scope": {
   "sites": [
    "src/rewind/snapshot.ts"
   ],
   "enumeration_method": "the reviewer read the changed files; static review, tests not run by the reviewer"
  }
 }
]
```
