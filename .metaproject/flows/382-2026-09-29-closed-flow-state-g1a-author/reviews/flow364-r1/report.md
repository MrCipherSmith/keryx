# PR #795 review (flow364-pr795-review)

No blocker: nothing gates, exit code unchanged, no model code. Five findings, all low severity.

```json keryx:findings
[
 {
  "id": "F-001",
  "reviewer": "flow364-pr795-review",
  "severity": "minor",
  "problem": "Plain git status opportunistically rewrites .git/index and takes index.lock, so the read-only note was not read-only against the index.",
  "impact": "A concurrent operator git commit or git add could fail with Unable to create index.lock while flow status or the TUI list ran.",
  "suggested_fix": "Run every git call with --no-optional-locks.",
  "evidence": "the reviewer measured the index mtime in a scratch repo",
  "confidence": "high",
  "file": "src/flow/uncommitted-state.ts",
  "line": 75,
  "quote": "spawnGit",
  "class_scope": {
   "sites": [
    "src/flow/uncommitted-state.ts"
   ],
   "enumeration_method": "the reviewer read the diff and ran edge inputs"
  }
 },
 {
  "id": "F-002",
  "reviewer": "flow364-pr795-review",
  "severity": "minor",
  "problem": "The TUI git pass had no timeout and ran ls-files and status even with no done flows.",
  "impact": "A hung git on a network filesystem stalled loadInspectorFlows and the list open.",
  "suggested_fix": "Bound the git calls and skip the pass when there are no done flows.",
  "evidence": "the reviewer compared with computeAcCheckStaleness which bounds its git call",
  "confidence": "high",
  "file": "src/tui/inspector-sources.ts",
  "line": 1,
  "quote": "uncommittedFlowStateNotes call",
  "class_scope": {
   "sites": [
    "src/tui/inspector-sources.ts"
   ],
   "enumeration_method": "the reviewer read the diff and ran edge inputs"
  }
 },
 {
  "id": "F-003",
  "reviewer": "flow364-pr795-review",
  "severity": "minor",
  "problem": "The batch variant re-split the whole ls-files and status listings for every flow.",
  "impact": "600 done flows with 25 tracked files each took 1329 ms against 57 ms for one call.",
  "suggested_fix": "Group the listings by flow directory once and look up per flow.",
  "evidence": "the reviewer benchmarked it",
  "confidence": "high",
  "file": "src/flow/uncommitted-state.ts",
  "line": 50,
  "quote": "noteFor insideDir",
  "class_scope": {
   "sites": [
    "src/flow/uncommitted-state.ts"
   ],
   "enumeration_method": "the reviewer read the diff and ran edge inputs"
  }
 },
 {
  "id": "F-004",
  "reviewer": "flow364-pr795-review",
  "severity": "minor",
  "problem": "The batch function was tested with one flow only and flow complete printing the note only on success, with the exit code unchanged, was untested.",
  "impact": "A disagreement between the batch and scoped logic on mixed directories, or a note on a refused completion, would not fail any test.",
  "suggested_fix": "Add mixed-directory batch tests and a flow complete test.",
  "evidence": "the reviewer read the tests",
  "confidence": "high",
  "file": "src/flow/uncommitted-state-note.test.ts",
  "line": 49,
  "quote": "batch vs single",
  "class_scope": {
   "sites": [
    "src/flow/uncommitted-state-note.test.ts"
   ],
   "enumeration_method": "the reviewer read the diff and ran edge inputs"
  }
 },
 {
  "id": "F-005",
  "reviewer": "flow364-pr795-review",
  "severity": "info",
  "problem": "The note and the docs asserted the uncommitted changes were the closing state flow complete wrote.",
  "impact": "A hand-edited file in the directory would get a wrong cause attributed to it.",
  "suggested_fix": "Say the directory has uncommitted changes and name the closing state as a common cause.",
  "evidence": "the reviewer read the note text",
  "confidence": "high",
  "file": "docs/docs/cli-reference.md",
  "line": 1,
  "quote": "closing state wording",
  "class_scope": {
   "sites": [
    "docs/docs/cli-reference.md"
   ],
   "enumeration_method": "the reviewer read the diff and ran edge inputs"
  }
 }
]
```
