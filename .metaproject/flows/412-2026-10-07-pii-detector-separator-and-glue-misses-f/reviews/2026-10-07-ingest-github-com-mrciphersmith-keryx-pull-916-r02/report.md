# Round 6 carry-forward (S2-S5), recorded only to attach decided-by

No reviewer ran. The four pre-existing findings S2-S5 of round 6 are carried forward unchanged so that their disposition can name the operator's decision (poll 116, 2026-10-07). The verifier verdicts were produced at 05ce8851 in round 6.

```json keryx:findings
[
 {
  "id": "r7-S2",
  "reviewer": "review-security-code",
  "severity": "minor",
  "problem": "A hyphen- or dot-joined phone followed by more digits is not reported (\"415-555-0199-123456\", \"415.555.0199.415.555.0199\").",
  "impact": "The number stays readable in redacted output. Pre-existing in baseline 6f6d8898.",
  "suggested_fix": "Split over-long runs on hyphen and dot, not only whitespace.",
  "evidence": "Carried forward from 2026-10-07-ingest-github-com-mrciphersmith-keryx-pull-916#r6-S2 so the disposition can record who decided. No new review ran. Reported in round 6 against 9d4cbc36 (PR 916). Deferred to flow 412 by operator poll 113.",
  "confidence": "medium"
 },
 {
  "id": "r7-S3",
  "reviewer": "review-security-code",
  "severity": "minor",
  "problem": "PII glued to word characters is not matched (\"id4111111111111111\", \"tel415-555-0199\", \"GB82WEST12345698765432dolor\", \"192.168.1.10abc\").",
  "impact": "The value stays readable in redacted output. Pre-existing.",
  "suggested_fix": "Relax the boundary and keep the Luhn and mod-97 checks as the guard.",
  "evidence": "Carried forward from 2026-10-07-ingest-github-com-mrciphersmith-keryx-pull-916#r6-S3 so the disposition can record who decided. No new review ran. Reported in round 6 against 9d4cbc36 (PR 916). Deferred to flow 412 by operator poll 113.",
  "confidence": "medium"
 },
 {
  "id": "r7-S4",
  "reviewer": "review-security-code",
  "severity": "minor",
  "problem": "Separators outside the fold set evade SSN, card, phone and IP rules (U+200B, U+200D, U+2060, U+00AD, U+058A, U+30FC, U+2043, newline or tab inside, and card separators . / _).",
  "impact": "The value stays readable in redacted output. Pre-existing.",
  "suggested_fix": "Extend the fold set and the card separators.",
  "evidence": "Carried forward from 2026-10-07-ingest-github-com-mrciphersmith-keryx-pull-916#r6-S4 so the disposition can record who decided. No new review ran. Reported in round 6 against 9d4cbc36 (PR 916). Deferred to flow 412 by operator poll 113.",
  "confidence": "medium"
 },
 {
  "id": "r7-S5",
  "reviewer": "review-security-code",
  "severity": "minor",
  "problem": "A fullwidth-letter IBAN is not detected; only the trailing digits are masked as a phone.",
  "impact": "The country code, check digits and bank code stay readable.",
  "suggested_fix": "Fold fullwidth Latin letters in the normaliser.",
  "evidence": "Carried forward from 2026-10-07-ingest-github-com-mrciphersmith-keryx-pull-916#r6-S5 so the disposition can record who decided. No new review ran. Reported in round 6 against 9d4cbc36 (PR 916). Deferred to flow 412 by operator poll 113.",
  "confidence": "medium"
 }
]
```
