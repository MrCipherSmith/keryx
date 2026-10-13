# Flow 261 closing round on merged main 7b93fc97

Closing round for flow 261 on the merged state. Target head is the recorded PR #906 head 19321fa3 (merge 7b93fc97). It restates every finding of rounds 1 to 3 under its original global id, so each supersedes its earlier record, and attaches an execution check run on the merge commit. The three review rounds were run by fresh independent reviewers (review-logic, review-security-code); the checks in this round were run by a different actor, flow261-closeout-verifier. Round 1 findings were fixed in 7078e6c9 and 9cb8ddc3, round 2 findings in 1280d3b2, round 3 findings in 19321fa3. F-005 is a pre-existing observation the reviewer said was not introduced by this PR; it was not changed.

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
    "file": "src/security/detect/pii.ts",
    "line": 377,
    "quote": "if (rule.policyId === \"pii.ssn\" && isIdentifierFragment(content, m.index, m.index + m[0].length)) {",
    "class_scope": {
      "sites": [
        "src/security/detect/pii.ts detectPii (the pii.ssn call to isIdentifierFragment, reviewer cites line 377): applies the shared guard with no label check; this is the defect",
        "src/security/detect/pii.ts isIdentifierFragment (lines 310-324): accepts any 8+ char hex run anywhere in the token and ignores an ssn label"
      ],
      "enumeration_method": "Differential bun script of the merge-base pii.ts against the PR head on 29 hand-picked inputs plus 200k fuzzed strings; the guard is reached only from the pii.ssn call site and the pii.phone call site, and only the pii.ssn one is in scope."
    },
    "global_id": "2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-906#F-001"
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
    "file": "src/security/detect/pii.ts",
    "line": 377,
    "quote": "if (rule.policyId === \"pii.ssn\" && isIdentifierFragment(content, m.index, m.index + m[0].length)) {",
    "global_id": "2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-906#F-002"
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
    "file": "src/security/detect/pii.ts",
    "line": 377,
    "quote": "if (rule.policyId === \"pii.ssn\" && isIdentifierFragment(content, m.index, m.index + m[0].length)) {",
    "class_scope": {
      "sites": [
        "src/security/detect/pii.ts isHexIdentifierRun (lines 293-295): the evidence test is only that a run looks hex",
        "src/security/detect/pii.ts isIdentifierFragment (lines 310-325) and the pii.ssn call site (line 377): suppress on any such run",
        "consumers of redactSensitiveText: src/intake/assess.ts, src/remote/rendering.ts, src/security/output-validation.ts, src/contracts/export-audit.ts (leak paths, not defect sites)"
      ],
      "enumeration_method": "Bun scripts against the worktree on detectPii and redactSensitiveText; consumers listed by the reviewer from a keryx ctx rg of redactSensitiveText."
    },
    "global_id": "2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-906#F-003"
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
    "file": "src/security/detect/pii.ts",
    "line": 377,
    "quote": "if (rule.policyId === \"pii.ssn\" && isIdentifierFragment(content, m.index, m.index + m[0].length)) {",
    "global_id": "2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-906#F-004"
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
    "file": "src/security/detect/pii.ts",
    "line": null,
    "quote": "regex:",
    "global_id": "2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-906#F-005"
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
    "file": "src/security/detect/pii.ts",
    "line": 377,
    "quote": "if (rule.policyId === \"pii.ssn\" && isIdentifierFragment(content, m.index, m.index + m[0].length)) {",
    "global_id": "2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-906#F-006"
  },
  {
    "id": "F-007",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "The sweep test case `file_${digest}_${SSN}.bin` cannot fail. \\b never matches next to `_`, so the old code also returns 0 findings for md5_123-45-6789, and the `-`/`_` branches in pii.ts (lines 389 and 392 at that head) for `_` are unreachable.",
    "impact": "The test claims coverage it does not have; it is the out-of-scope word-character case.",
    "suggested_fix": "Remove the case and the unreachable underscore branches.",
    "evidence": "Reviewer ran the worktree against the merge-base pii.ts (0667ca01) with three bun scripts, fuzzing 300k strings for phone parity and 400k realistic strings against an independent regex oracle (0 mismatches); bun test src/security/detect: 216 pass, 0 fail.",
    "confidence": "high",
    "file": "src/security/detect/pii-identifier-sweep.test.ts",
    "line": null,
    "quote": "file_${digest}_${SSN}.bin",
    "global_id": "2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-906-r02#F-001"
  },
  {
    "id": "F-008",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "The UUID_TOKEN branch of the SSN guard is unreachable for SSN: a UUID has no 3-2-4 digit shape with \\b boundaries, and no test covers it.",
    "impact": "Dead code in the guard that reads as if it were evidence.",
    "suggested_fix": "Remove the branch.",
    "evidence": "Same bun scripts and fuzz as F-001; the reviewer cites pii.ts:383.",
    "confidence": "high",
    "file": "src/security/detect/pii.ts",
    "line": 383,
    "quote": "if (UUID_TOKEN.test(content.slice(tokenStart, tokenEnd))) {",
    "global_id": "2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-906-r02#F-002"
  },
  {
    "id": "F-009",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "A label after the token is not checked: `<md5>-123-45-6789 is the SSN` is suppressed. This is a narrow gap against the earlier finding's rule that a label must never allow suppression, if labels placed after the number count.",
    "impact": "A labelled SSN beside a real hash is suppressed when the label follows it.",
    "suggested_fix": "Veto suppression on a label in a short same-sentence window after the token.",
    "evidence": "Same bun scripts as F-001; the reviewer cites pii.ts:377-381.",
    "confidence": "high",
    "file": "src/security/detect/pii.ts",
    "line": 377,
    "quote": "if (SSN_LABEL.test(content.slice(tokenStart, tokenEnd))) {",
    "global_id": "2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-906-r02#F-003"
  },
  {
    "id": "F-010",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "Changing SSN_LABEL_LOOKAHEAD from 24 to 12 still passes every test. The existing cases use labels of 11 and 9 characters, so nothing sits near the 24 boundary; raising it to 60 does fail, so only the upper side was pinned.",
    "impact": "The label window could shrink so that a label at characters 13-24 stops vetoing, with all tests still green.",
    "suggested_fix": "Add a case with a label ending at exactly character 24 after the token and one at 25.",
    "evidence": "Mutated a scratchpad copy of pii.ts and ran the PR's pii-identifier-sweep.test.ts against it; bun test src/security/detect: 217 pass, 0 fail on the unmutated head.",
    "confidence": "high",
    "file": "src/security/detect/pii.ts",
    "line": 346,
    "quote": "const SSN_LABEL_LOOKAHEAD = 24;",
    "global_id": "2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-906-r03#F-001"
  },
  {
    "id": "F-011",
    "reviewer": "review-logic",
    "severity": "minor",
    "problem": "Changing SSN_LABEL_LOOKBEHIND from 32 to 200 still passes every test: no test checks that a label more than 32 characters before the token does not veto. Lowering it to 4 does fail.",
    "impact": "The look-behind window could widen unnoticed; this matters only if `just before` is meant to be bounded.",
    "suggested_fix": "Add a boundary pair: a label starting 32 characters before the token still vetoes, one starting at 33 does not.",
    "evidence": "Mutated a scratchpad copy of pii.ts and ran the PR's sweep test against it.",
    "confidence": "high",
    "file": "src/security/detect/pii.ts",
    "line": 345,
    "quote": "const SSN_LABEL_LOOKBEHIND = 32;",
    "global_id": "2026-10-05-ingest-github-com-mrciphersmith-keryx-pull-906-r03#F-002"
  }
]
```
