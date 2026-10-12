# Flow 261 review round 2 on PR #906 (recheck at 7078e6c9)

An independent review-logic recheck at head 7078e6c9 confirmed the round 1 fixes F1-F4 (label veto, adjacent real hash only, 64-hex consistency, match-offset split) by executing every listed input, a 300k phone-parity fuzz and a 400k oracle fuzz, found no blocker or major, and reported three minors. They were fixed in commit 1280d3b2.

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/security/detect/pii-identifier-sweep.test.ts",
    "line": 90,
    "quote": "file_${digest}_${SSN}.bin",
    "problem": "The sweep test case `file_${digest}_${SSN}.bin` cannot fail. \\b never matches next to `_`, so the old code also returns 0 findings for md5_123-45-6789, and the `-`/`_` branches in pii.ts (lines 389 and 392 at that head) for `_` are unreachable.",
    "impact": "The test claims coverage it does not have; it is the out-of-scope word-character case.",
    "suggested_fix": "Remove the case and the unreachable underscore branches.",
    "evidence": "Reviewer ran the worktree against the merge-base pii.ts (0667ca01) with three bun scripts, fuzzing 300k strings for phone parity and 400k realistic strings against an independent regex oracle (0 mismatches); bun test src/security/detect: 216 pass, 0 fail.",
    "confidence": "high"
  },
  {
    "id": "F-002",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/security/detect/pii.ts",
    "line": 383,
    "quote": "if (UUID_TOKEN.test(content.slice(tokenStart, tokenEnd))) {",
    "problem": "The UUID_TOKEN branch of the SSN guard is unreachable for SSN: a UUID has no 3-2-4 digit shape with \\b boundaries, and no test covers it.",
    "impact": "Dead code in the guard that reads as if it were evidence.",
    "suggested_fix": "Remove the branch.",
    "evidence": "Same bun scripts and fuzz as F-001; the reviewer cites pii.ts:383.",
    "confidence": "high"
  },
  {
    "id": "F-003",
    "reviewer": "review-logic",
    "severity": "minor",
    "file": "src/security/detect/pii.ts",
    "line": 377,
    "quote": "if (SSN_LABEL.test(content.slice(tokenStart, tokenEnd))) {",
    "problem": "A label after the token is not checked: `<md5>-123-45-6789 is the SSN` is suppressed. This is a narrow gap against the earlier finding's rule that a label must never allow suppression, if labels placed after the number count.",
    "impact": "A labelled SSN beside a real hash is suppressed when the label follows it.",
    "suggested_fix": "Veto suppression on a label in a short same-sentence window after the token.",
    "evidence": "Same bun scripts as F-001; the reviewer cites pii.ts:377-381.",
    "confidence": "high"
  }
]
```
