# Review finding 2026-09-28-pr-779-round3-9b0b3f58#DOC-F1 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-testing-practices raised 2026-09-28-pr-779-round3-9b0b3f58#DOC-F1 (minor) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-28-pr-779-round3-9b0b3f58#DOC-F1` (display id `DOC-F1`)
- Reviewer: `review-testing-practices`
- Severity: `minor`
- Location: `src/security/detect/entropy.ts`
- Origin: `internal`
- What it claimed: The file header comment added this round (entropy.ts:168-171) claims token=abcdefghijklmnopqrstuvwx12345678 is 'DELIBERATELY still missed' because 'its value is low-entropy'. This is factually wrong: a string with 32-33 distinct characters has entropy near the theoretical maximum, not low. The code's own test, added in the same diff, correctly documents and pins the OPPOSITE behaviour, but the header comment was not updated to match.
- Why it was dismissed: refuted by review-verifier (site-check): keryx ctx rg 'DELIBERATELY|maximal-entropy' src/security/detect/entropy.ts at 536a6971: the finding's quoted text ('DELIBERATELY still missed... low-entropy') is gone. src/security/detect/entropy.ts:168-176 now reads 'token=abcdefghijklmnopqrstuvwx12345678 IS caught, and correctly so: all 32 characters are DISTINCT, so its Shannon entropy is exactly log2(32) = 5' — matching entropy.test.ts's own R3 framing that the finding asked for.
- Attested by: verifier — review-verifier (site-check): keryx ctx rg 'DELIBERATELY|maximal-entropy' src/security/detect/entropy.ts at 536a6971: the finding's quoted text ('DELIBERATELY still missed... low-entropy') is gone. src/security/detect/entropy.ts:168-176 now reads 'token=abcdefghijklmnopqrstuvwx12345678 IS caught, and correctly so: all 32 characters are DISTINCT, so its Shannon entropy is exactly log2(32) = 5' — matching entropy.test.ts's own R3 framing that the finding asked for.

Only `dismissed-incorrect` reaches this folder. `dismissed-wont-fix`,
`dismissed-out-of-scope` and `dismissed-deprioritised` describe findings that
were CORRECT and were not acted on; counting them here would teach the reviewer
to stop raising true findings.

## Provenance

- Source: review
- Link: .metaproject/flows/355-2026-09-28-audit-remediation-2-security-depth-entro/reviews/2026-09-28-pr-781-round5-verdicts
- Created: 2026-09-28
- Updated: 2026-09-28

## Related Scopes

- Module:
- Entity:
- Files:
- Skills:

## Tags

- review-note
- false-positive
- round:2026-09-28-pr-781-round5-verdicts
- commit:22478bc0a9970324373cbe38fb5fd7e34568f64c

## Changelog

- 0.1.0 - Written by `keryx review` when the finding was dismissed as incorrect.
