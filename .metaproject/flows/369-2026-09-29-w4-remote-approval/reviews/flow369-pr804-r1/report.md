# PR #804 review (flow369-pr804-review)

No blocker. One major, seven minor. The review was static.

```json keryx:findings
[
 {
  "id": "F-001",
  "reviewer": "flow369-pr804-review",
  "severity": "major",
  "problem": "Startup reconciliation runs before the bind, so a second listener that fails to bind still resolves the records of the running one.",
  "impact": "A second start expires-denies pending approvals and abandons allowed ones of a live listener.",
  "suggested_fix": "Reconcile only after a successful bind.",
  "evidence": "the reviewer read the changed files; static review, not run",
  "confidence": "high",
  "file": "src/lib/serve-server.ts",
  "line": 1030,
  "quote": "reconcileApprovals(input.dir, { isTurnLive: () => false });",
  "class_scope": {
   "sites": [
    "src/lib/serve-server.ts"
   ],
   "enumeration_method": "the reviewer read the changed files; static review, tests not run by the reviewer"
  }
 },
 {
  "id": "F-002",
  "reviewer": "flow369-pr804-review",
  "severity": "minor",
  "problem": "The guide promises that pending approvals survive a restart and that an allow does not override the hook-ask floor; startup expires them and the floors are labels.",
  "impact": "The guide states more than the code does.",
  "suggested_fix": "Reword the guide and the CLI help.",
  "evidence": "the reviewer read the changed files; static review, not run",
  "confidence": "high",
  "file": "docs/docs/guides/answer-remote-approvals.md",
  "line": 40,
  "quote": "Pending approvals survive a listener restart.",
  "class_scope": {
   "sites": [
    "docs/docs/guides/answer-remote-approvals.md"
   ],
   "enumeration_method": "the reviewer read the changed files; static review, tests not run by the reviewer"
  }
 },
 {
  "id": "F-003",
  "reviewer": "flow369-pr804-review",
  "severity": "minor",
  "problem": "When the ledger append fails after the request file was written, the record stays pending while the turn is already denied.",
  "impact": "An answer can be given for a call that was already denied, and the record counts against the pending limit.",
  "suggested_fix": "Resolve the record as undeliverable before returning.",
  "evidence": "the reviewer read the changed files; static review, not run",
  "confidence": "high",
  "file": "src/lib/serve-approvals-broker.ts",
  "line": 75,
  "quote": "record-unwritable",
  "class_scope": {
   "sites": [
    "src/lib/serve-approvals-broker.ts"
   ],
   "enumeration_method": "the reviewer read the changed files; static review, tests not run by the reviewer"
  }
 },
 {
  "id": "F-004",
  "reviewer": "flow369-pr804-review",
  "severity": "minor",
  "problem": "The resolution file is created before the ledger append, so a failed append throws with the state already applied.",
  "impact": "A route can answer 500 with the allow applied and no ledger event.",
  "suggested_fix": "Report the ledger failure without failing the transition.",
  "evidence": "the reviewer read the changed files; static review, not run",
  "confidence": "high",
  "file": "src/lib/serve-approvals-store.ts",
  "line": 300,
  "quote": "resolveApproval",
  "class_scope": {
   "sites": [
    "src/lib/serve-approvals-store.ts"
   ],
   "enumeration_method": "the reviewer read the changed files; static review, tests not run by the reviewer"
  }
 },
 {
  "id": "F-005",
  "reviewer": "flow369-pr804-review",
  "severity": "minor",
  "problem": "The resolution is written in place after an exclusive create, so a concurrent reader can see a partial file.",
  "impact": "It fails closed as a denial; a crash in the window leaves a permanent denial.",
  "suggested_fix": "Write a temp file and link it exclusively.",
  "evidence": "the reviewer read the changed files; static review, not run",
  "confidence": "high",
  "file": "src/lib/config-dir.ts",
  "line": 1,
  "quote": "createOwnerOnlyFileExclusive",
  "class_scope": {
   "sites": [
    "src/lib/config-dir.ts"
   ],
   "enumeration_method": "the reviewer read the changed files; static review, tests not run by the reviewer"
  }
 },
 {
  "id": "F-006",
  "reviewer": "flow369-pr804-review",
  "severity": "minor",
  "problem": "Reconciliation resolves the approval but not the stranded turn record.",
  "impact": "The turn reports running and answers 409 to later submissions.",
  "suggested_fix": "Finish the orphaned turn when its approval is expired at startup.",
  "evidence": "the reviewer read the changed files; static review, not run",
  "confidence": "high",
  "file": "src/lib/serve-approvals-store.ts",
  "line": 428,
  "quote": "reconcileApprovals",
  "class_scope": {
   "sites": [
    "src/lib/serve-approvals-store.ts"
   ],
   "enumeration_method": "the reviewer read the changed files; static review, tests not run by the reviewer"
  }
 },
 {
  "id": "F-007",
  "reviewer": "flow369-pr804-review",
  "severity": "minor",
  "problem": "The guide states the self-grant rule as stronger than it is; the local CLI and the store need no token.",
  "impact": "A reader assumes the store's directory is not a way to answer.",
  "suggested_fix": "State that the local path answers without a token.",
  "evidence": "the reviewer read the changed files; static review, not run",
  "confidence": "high",
  "file": "docs/docs/guides/answer-remote-approvals.md",
  "line": 132,
  "quote": "a turn's own tools hold no serve token",
  "class_scope": {
   "sites": [
    "docs/docs/guides/answer-remote-approvals.md"
   ],
   "enumeration_method": "the reviewer read the changed files; static review, tests not run by the reviewer"
  }
 },
 {
  "id": "F-008",
  "reviewer": "flow369-pr804-review",
  "severity": "minor",
  "problem": "listApprovals and countPending scan every approval ever written, on each status call and each TUI poll.",
  "impact": "Latency grows with the number of approvals and nothing prunes.",
  "suggested_fix": "Bound the scan and prune old resolved records.",
  "evidence": "the reviewer read the changed files; static review, not run",
  "confidence": "high",
  "file": "src/lib/serve-approvals-store.ts",
  "line": 398,
  "quote": "listApprovals",
  "class_scope": {
   "sites": [
    "src/lib/serve-approvals-store.ts"
   ],
   "enumeration_method": "the reviewer read the changed files; static review, tests not run by the reviewer"
  }
 }
]
```
