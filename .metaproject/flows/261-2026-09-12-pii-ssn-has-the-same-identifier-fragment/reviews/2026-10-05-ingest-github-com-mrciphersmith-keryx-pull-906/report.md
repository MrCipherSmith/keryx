# Flow 261 review round 1 on PR #906 (pii.ssn identifier-fragment guard)

Two independent reviewers (review-logic, review-security-code) read the PR diff at head 9bb2e504 (the head before commit 7078e6c9) and probed the worktree with bun scripts. Findings below are their reported findings, condensed. Fixes landed in 7078e6c9 and 9cb8ddc3 (the latter drops an unused constant after a CI lint failure).

```json keryx:findings
[
  {
    "id": "F-001",
    "reviewer": "review-logic",
    "severity": "major",
    "problem": "A label next to the SSN does not stop the hex suppression. isIdentifierFragment looks for a hex run of 8 or more characters anywhere in the same [0-9A-Za-z_-] token and ignores an explicit `ssn` label in that token, so an SSN-shaped run in a labelled token that also carries a hex run is suppressed.",
    "impact": "A real SSN that the old rule redacted now passes through verbatim. Old redacted, new returned [] for: john-smith-ssn-123-45-6789-deadbeef, Employee-ID-deadbeef-SSN-123-45-6789, abcdef12-ssn-123-45-6789, SSN:123-45-6789-abcdef0123. No test pinned these.",
    "suggested_fix": "Do not suppress when the token carries an ssn/social label; alternatively take the hex-neighbour signal only from the immediately adjacent segment.",
    "evidence": "Differential bun script of the merge-base pii.ts (0667ca01) against the PR head on 29 hand-picked inputs plus 200k fuzzed strings; bun test src/security/detect/pii: 35 pass, 0 fail. Reviewer cites pii.ts:377 (guard in detectPii) and pii.ts:310-324 (isIdentifierFragment).",
    "confidence": "high",
    "line": 101,
    "quote": "if (rule.policyId === \"pii.ssn\" && isIdentifierFragment(content, m.index, m.index + m[0].length)) {",
    "file": "src/security/detect/pii.ts",
    "class_scope": {
      "sites": [
        "src/security/detect/pii.ts detectPii (the pii.ssn call to isIdentifierFragment, reviewer cites line 377): applies the shared guard with no label check; this is the defect",
        "src/security/detect/pii.ts isIdentifierFragment (lines 310-324): accepts any 8+ char hex run anywhere in the token and ignores an ssn label"
      ],
      "enumeration_method": "Differential bun script of the merge-base pii.ts against the PR head on 29 hand-picked inputs plus 200k fuzzed strings; the guard is reached only from the pii.ssn call site and the pii.phone call site, and only the pii.ssn one is in scope."
    }
  },
  {
    "id": "F-002",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "The hex test is loose. A run of 8 or more characters of [0-9A-Fa-f] with at least one letter counts as hex evidence, so digit-heavy identifiers that are not hashes also suppress the SSN.",
    "impact": "Old redacted, new returned [] for 20260912a-123-45-6789 and case-1234567e-123-45-6789. AC4 speaks of hash digits. The reviewer noted this is the same looseness as the phone guard and hex-letter words such as deadbeef also count.",
    "suggested_fix": "Require a real hash adjacent to the SSN rather than any short hex-looking run.",
    "evidence": "Same differential script as F-001; the two inputs above were observed to change from redacted to suppressed.",
    "confidence": "high",
    "line": 101,
    "quote": "if (rule.policyId === \"pii.ssn\" && isIdentifierFragment(content, m.index, m.index + m[0].length)) {",
    "file": "src/security/detect/pii.ts"
  },
  {
    "id": "F-003",
    "reviewer": "review-security-code",
    "severity": "major",
    "problem": "A real SSN passes through verbatim when it sits next to any hex run of 8 or more characters containing a letter. The evidence test is only that the neighbour looks hex, never that it is a real digest, so any string the writer controls satisfies it.",
    "impact": "Leaking inputs on both detectPii and redactSensitiveText: deadbeef-123-45-6789, ssn-a1b2c3d4-123-45-6789, ssn: deadbeef-123-45-6789, user_deadbeef_123-45-6789, 123-45-6789-deadbeef, a 32-hex digest or a UUID next to the SSN, 1234567e-123-45-6789, ssn-12345678a-123-45-6789, and the ordinary-looking E1234567-123-45-6789. redactSensitiveText is used on intake, remote rendering, output validation and export audit. The reviewer rated it the same accepted residual as the phone guard of flow 260, but with a worse consequence for SSN.",
    "suggested_fix": "Require a longer run (16+ characters) or an exact 32/40/64 digest or a UUID token, adjacent to the match.",
    "evidence": "Bun scripts against the worktree exercising detectPii and redactSensitiveText; the same inputs leak for phone with 415-555-0199. Reviewer cites pii.ts:293-295 (isHexIdentifierRun), 310-325 and 377.",
    "confidence": "high",
    "line": 101,
    "quote": "if (rule.policyId === \"pii.ssn\" && isIdentifierFragment(content, m.index, m.index + m[0].length)) {",
    "file": "src/security/detect/pii.ts",
    "class_scope": {
      "sites": [
        "src/security/detect/pii.ts isHexIdentifierRun (lines 293-295): the evidence test is only that a run looks hex",
        "src/security/detect/pii.ts isIdentifierFragment (lines 310-325) and the pii.ssn call site (line 377): suppress on any such run",
        "consumers of redactSensitiveText: src/intake/assess.ts, src/remote/rendering.ts, src/security/output-validation.ts, src/contracts/export-audit.ts (leak paths, not defect sites)"
      ],
      "enumeration_method": "Bun scripts against the worktree on detectPii and redactSensitiveText; consumers listed by the reviewer from a keryx ctx rg of redactSensitiveText."
    }
  },
  {
    "id": "F-004",
    "reviewer": "review-security-code",
    "severity": "info",
    "problem": "Accidental asymmetry: a 64-hex digest next to the SSN is redacted only because the 64-character scan window marks the token truncated, while 32-hex and 40-hex digests and UUIDs suppress. Phone behaves the same.",
    "impact": "The decided rule treats digests consistently; a sha256 neighbour behaved differently by accident of the scan window.",
    "suggested_fix": "Make the 64-hex neighbour consistent with the 32 and 40 cases.",
    "evidence": "Bun script against the worktree.",
    "confidence": "high",
    "line": 101,
    "quote": "if (rule.policyId === \"pii.ssn\" && isIdentifierFragment(content, m.index, m.index + m[0].length)) {",
    "file": "src/security/detect/pii.ts"
  },
  {
    "id": "F-005",
    "reviewer": "review-security-code",
    "severity": "info",
    "problem": "Pre-existing, not introduced by this PR: the \\b-anchored pii.ssn regex never matches an SSN glued to word characters, for example abc123-45-6789 or x_123-45-6789, with or without the guard. Same for phone.",
    "impact": "Observation only; behaviour is unchanged by flow 261.",
    "suggested_fix": "None for this flow.",
    "evidence": "Bun script against the worktree; the reviewer states it is pre-existing and not introduced by the PR.",
    "confidence": "high",
    "quote": "regex:",
    "file": "src/security/detect/pii.ts"
  },
  {
    "id": "F-006",
    "reviewer": "review-security-code",
    "severity": "info",
    "problem": "token.indexOf(match) in isIdentifierFragment takes the first textual occurrence, so with repeated identical SSNs in one token the before/after split can be computed on the wrong occurrence.",
    "impact": "No leak found (123-45-6789-123-45-6789 is still caught), but the approach is fragile.",
    "suggested_fix": "Split at the match's actual offset.",
    "evidence": "Reviewer cites pii.ts:322; no leaking input was found.",
    "confidence": "medium",
    "line": 101,
    "quote": "if (rule.policyId === \"pii.ssn\" && isIdentifierFragment(content, m.index, m.index + m[0].length)) {",
    "file": "src/security/detect/pii.ts"
  }
]
```
