# PR #796 review (flow365-pr796-review)

No blocker and no major: the flag gates nothing, never infers human, old files are not rewritten, journal injection through --reason is refused. Three minor findings. The review was static; the CI lint failure on the head was fixed separately in the same commit.

```json keryx:findings
[
 {
  "id": "F-001",
  "reviewer": "flow365-pr796-review",
  "severity": "minor",
  "problem": "A repeated or mixed --outcome-author resolved unpredictably: the spaced form beat the = form and the first occurrence won.",
  "impact": "flow init --title x --outcome-author=agent --outcome-author human silently recorded human, which decides the human row of G1a and G1b, so a mistyped command line mislabels the sample.",
  "suggested_fix": "Count occurrences of the flag in runInit and refuse more than one before creating the flow.",
  "evidence": "the reviewer read optionValue in src/lib/args.ts and runInit; not run",
  "confidence": "high",
  "file": "src/commands/flow.ts",
  "line": 439,
  "quote": "outcomeAuthorFlag",
  "class_scope": {
   "sites": [
    "src/commands/flow.ts"
   ],
   "enumeration_method": "the reviewer read the diff; static review, tests not run by the reviewer"
  }
 },
 {
  "id": "F-002",
  "reviewer": "flow365-pr796-review",
  "severity": "minor",
  "problem": "The CLI setter read the previous value outside the lock, so under a concurrent change its message could contradict what happened.",
  "impact": "Two racing setters could print already human, nothing written when the opposite occurred, or a stale agent -> human.",
  "suggested_fix": "Have the service return the previous value from inside the lock.",
  "evidence": "the reviewer read runOutcome and outcomeAuthorSet; not run",
  "confidence": "high",
  "file": "src/commands/flow.ts",
  "line": 994,
  "quote": "runOutcome before via get",
  "class_scope": {
   "sites": [
    "src/commands/flow.ts"
   ],
   "enumeration_method": "the reviewer read the diff; static review, tests not run by the reviewer"
  }
 },
 {
  "id": "F-003",
  "reviewer": "flow365-pr796-review",
  "severity": "minor",
  "problem": "AUTHOR_READINGS duplicated the agent|human|unknown vocabulary instead of importing it through the flow facade.",
  "impact": "The two lists can drift apart and product would then accept or reject a value flow does not know.",
  "suggested_fix": "Import the vocabulary through src/flow/service.ts.",
  "evidence": "the reviewer read store.ts and outcome-author.ts; not run",
  "confidence": "high",
  "file": "src/product/store.ts",
  "line": 1,
  "quote": "AUTHOR_READINGS",
  "class_scope": {
   "sites": [
    "src/product/store.ts"
   ],
   "enumeration_method": "the reviewer read the diff; static review, tests not run by the reviewer"
  }
 }
]
```
