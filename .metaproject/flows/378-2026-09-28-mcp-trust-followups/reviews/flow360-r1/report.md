# PR #798 review (flow360-pr798-review)

No blocker and no major. Three minor findings. The review was static.

```json keryx:findings
[
 {
  "id": "F-001",
  "reviewer": "flow360-pr798-review",
  "severity": "minor",
  "problem": "The /mcp trust list printed [trusted] for every grant, including one the next call would drop (definition changed, tool now destructive, tool gone).",
  "impact": "A stale grant looked live: the operator reads [trusted], but the next call asks again, so the list contradicts behaviour.",
  "suggested_fix": "Resolve staleness against the live catalog and print the reason instead of the marker.",
  "evidence": "the reviewer read renderTrustedToolLines and executeCall; not run",
  "confidence": "high",
  "file": "src/mcp-servers/approval-render.ts",
  "line": 591,
  "quote": "renderTrustedToolLines",
  "class_scope": {
   "sites": [
    "src/mcp-servers/approval-render.ts"
   ],
   "enumeration_method": "the reviewer read the diff; static review, tests not run by the reviewer"
  }
 },
 {
  "id": "F-002",
  "reviewer": "flow360-pr798-review",
  "severity": "minor",
  "problem": "mcpTrusted is set on the approval meta whenever a grant is held, even when the call still asks because trust is withheld.",
  "impact": "The approval line can show [trusted] on a call that asks, which may read as contradictory.",
  "suggested_fix": "Set mcpTrusted only when the grant is honoured.",
  "evidence": "the reviewer read executeCall; not run",
  "confidence": "high",
  "file": "src/commands/agent.ts",
  "line": 4563,
  "quote": "mcpTrusted: true",
  "class_scope": {
   "sites": [
    "src/commands/agent.ts"
   ],
   "enumeration_method": "the reviewer read the diff; static review, tests not run by the reviewer"
  }
 },
 {
  "id": "F-003",
  "reviewer": "flow360-pr798-review",
  "severity": "minor",
  "problem": "No test fed hostile revoke targets (all-caps ALL, all__, partial names, whitespace) to the revoke path.",
  "impact": "A loose match could revoke another grant or everything, and nothing would fail.",
  "suggested_fix": "Add hostile-input cases asserting no other grant is touched.",
  "evidence": "the reviewer read the trust tests; not run",
  "confidence": "high",
  "file": "src/mcp-servers/approval-render.trust.test.ts",
  "line": 1,
  "quote": "parseMcpTrustCommand",
  "class_scope": {
   "sites": [
    "src/mcp-servers/approval-render.trust.test.ts"
   ],
   "enumeration_method": "the reviewer read the diff; static review, tests not run by the reviewer"
  }
 }
]
```
