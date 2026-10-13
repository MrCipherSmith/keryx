# Round 6 on the PII detection code after PR 916

Target: `src/security/detect/pii.ts`. The reviewers (review-logic, review-security-code) read PR 916 at 9d4cbc36. The operator decided (poll 113, 2026-10-07) to fix findings 1-5 in PR 918 and track the older ones in flow 412. PR 918 is merged (05ce8851), and one review-verifier ran every finding against 05ce8851 by execution.

```json keryx:findings
[
 {
  "id": "r6-L1",
  "reviewer": "review-logic",
  "severity": "major",
  "problem": "A phone followed by a list marker (\"415-555-0199 1.\", \" 2)\", \" 3 -\") is dropped: the greedy sticky match swallows the marker digits and the verdict rejects the run.",
  "impact": "A phone number stays readable in redacted output.",
  "suggested_fix": "Retry the baseline end, then whitespace-cut prefixes, in the phone scanner.",
  "evidence": "Reported in round 6 against 9d4cbc36 (PR 916). Fixed in PR 918 (merge 05ce8851).",
  "confidence": "medium",
  "class_scope": {
   "sites": [
    "src/security/detect/pii.ts: phoneScanner / execPhone (sticky phone scan, end selection)",
    "src/security/detect/pii.ts: rescanPhoneRun (over-long digit-run rescan)"
   ],
   "enumeration_method": "Every phone-match end selection in pii.ts: the baseline end in the sticky scan and the rescan window end; the list-marker shapes (\"1.\", \"2)\", \"3 -\") and the separators - . space were tried against both, and the same shapes were run through the 120,000-input differential against baseline 6f6d8898."
  }
 },
 {
  "id": "r6-L2",
  "reviewer": "review-logic",
  "severity": "minor",
  "problem": "Overlapping spans from the plain and NFKC passes cause double masks.",
  "impact": "Redacted output carries two markers or a partial leftover.",
  "suggested_fix": "Coalesce same-rule spans; make applyRedaction mask a partial overlap with the marker already written.",
  "evidence": "Reported in round 6 against 9d4cbc36 (PR 916). Fixed in PR 918 (merge 05ce8851).",
  "confidence": "medium"
 },
 {
  "id": "r6-L3",
  "reviewer": "review-logic",
  "severity": "minor",
  "problem": "rescanPhoneRun builds false phone windows inside card, ID and table runs.",
  "impact": "False positives mask harmless numbers.",
  "suggested_fix": "Require separator evidence, anchor at a run start, never cross a line break or a 2+ space gap, drop windows overlapping a Luhn-valid card.",
  "evidence": "Reported in round 6 against 9d4cbc36 (PR 916). Fixed in PR 918 (merge 05ce8851).",
  "confidence": "medium"
 },
 {
  "id": "r6-L4",
  "reviewer": "review-logic",
  "severity": "minor",
  "problem": "Dead SSN identifier guard code (isSsnIdentifierFragment, SSN_LABEL, foldCache) is left behind and test titles still say veto.",
  "impact": "Dead code misleads maintainers about live behaviour.",
  "suggested_fix": "Remove the dead guard and rename the tests.",
  "evidence": "Reported in round 6 against 9d4cbc36 (PR 916). Fixed in PR 918 (merge 05ce8851).",
  "confidence": "medium"
 },
 {
  "id": "r6-L5",
  "reviewer": "review-logic",
  "severity": "info",
  "problem": "An unclosed describe in pii-normalised.test.ts, and the phone scanner pending queue is not reset at scan start.",
  "impact": "State can leak between scans after an aborted scan.",
  "suggested_fix": "Close the describe; reset the scanner at scan start.",
  "evidence": "Reported in round 6 against 9d4cbc36 (PR 916). Fixed in PR 918 (merge 05ce8851).",
  "confidence": "medium"
 },
 {
  "id": "r6-S1",
  "reviewer": "review-security-code",
  "severity": "minor",
  "problem": "The rescan emits a spurious phone span on every space-separated 16-digit card (\"Pay: 4111 1111 1111 1111, ok\" gives phone[5,19) and credit-card[5,24)).",
  "impact": "Double detection of one value.",
  "suggested_fix": "Same fix as L3.",
  "evidence": "Reported in round 6 against 9d4cbc36 (PR 916). Fixed in PR 918 (merge 05ce8851).",
  "confidence": "medium"
 },
 {
  "id": "r6-S2",
  "reviewer": "review-security-code",
  "severity": "minor",
  "problem": "A hyphen- or dot-joined phone followed by more digits is not reported (\"415-555-0199-123456\", \"415.555.0199.415.555.0199\").",
  "impact": "The number stays readable in redacted output. Pre-existing in baseline 6f6d8898.",
  "suggested_fix": "Split over-long runs on hyphen and dot, not only whitespace.",
  "evidence": "Reported in round 6 against 9d4cbc36 (PR 916). Deferred to flow 412 by operator poll 113.",
  "confidence": "medium"
 },
 {
  "id": "r6-S3",
  "reviewer": "review-security-code",
  "severity": "minor",
  "problem": "PII glued to word characters is not matched (\"id4111111111111111\", \"tel415-555-0199\", \"GB82WEST12345698765432dolor\", \"192.168.1.10abc\").",
  "impact": "The value stays readable in redacted output. Pre-existing.",
  "suggested_fix": "Relax the boundary and keep the Luhn and mod-97 checks as the guard.",
  "evidence": "Reported in round 6 against 9d4cbc36 (PR 916). Deferred to flow 412 by operator poll 113.",
  "confidence": "medium"
 },
 {
  "id": "r6-S4",
  "reviewer": "review-security-code",
  "severity": "minor",
  "problem": "Separators outside the fold set evade SSN, card, phone and IP rules (U+200B, U+200D, U+2060, U+00AD, U+058A, U+30FC, U+2043, newline or tab inside, and card separators . / _).",
  "impact": "The value stays readable in redacted output. Pre-existing.",
  "suggested_fix": "Extend the fold set and the card separators.",
  "evidence": "Reported in round 6 against 9d4cbc36 (PR 916). Deferred to flow 412 by operator poll 113.",
  "confidence": "medium"
 },
 {
  "id": "r6-S5",
  "reviewer": "review-security-code",
  "severity": "minor",
  "problem": "A fullwidth-letter IBAN is not detected; only the trailing digits are masked as a phone.",
  "impact": "The country code, check digits and bank code stay readable.",
  "suggested_fix": "Fold fullwidth Latin letters in the normaliser.",
  "evidence": "Reported in round 6 against 9d4cbc36 (PR 916). Deferred to flow 412 by operator poll 113.",
  "confidence": "medium"
 },
 {
  "id": "r6-S6",
  "reviewer": "review-security-code",
  "severity": "info",
  "problem": "The dead SSN guard (same as L4).",
  "impact": "Dead code.",
  "suggested_fix": "Remove it.",
  "evidence": "Reported in round 6 against 9d4cbc36 (PR 916). Fixed in PR 918 (merge 05ce8851).",
  "confidence": "medium"
 },
 {
  "id": "r6-S7",
  "reviewer": "review-security-code",
  "severity": "info",
  "problem": "Partial-window phone redaction can leave the tail of a second number readable (\"415 555 0199 415 ...\").",
  "impact": "Part of a second number stays readable.",
  "suggested_fix": "Continue the rescan from the window end.",
  "evidence": "Reported in round 6 against 9d4cbc36 (PR 916). Fixed in PR 918 (merge 05ce8851).",
  "confidence": "medium"
 },
 {
  "id": "r6-S8",
  "reviewer": "review-security-code",
  "severity": "info",
  "problem": "About 19 of 200,000 random UUIDs are flagged credit-card on a three-group prefix; hyphen-joined digit or hex groups are flagged as card or phone.",
  "impact": "False positives mask harmless tokens. Pre-existing.",
  "suggested_fix": "Do not treat UUID-shaped tokens as cards.",
  "evidence": "Reported in round 6 against 9d4cbc36 (PR 916). Deferred to flow 412 by operator poll 113.",
  "confidence": "medium"
 }
]
```
