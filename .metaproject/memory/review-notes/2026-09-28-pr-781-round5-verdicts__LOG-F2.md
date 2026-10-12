# Review finding 2026-09-28-pr-779-round3-9b0b3f58#LOG-F2 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-security-code raised 2026-09-28-pr-779-round3-9b0b3f58#LOG-F2 (major) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-28-pr-779-round3-9b0b3f58#LOG-F2` (display id `LOG-F2`)
- Reviewer: `review-security-code`
- Severity: `major`
- Location: `src/security/detect/entropy.ts`
- Origin: `internal`
- What it claimed: ADJACENT_LABEL (round 2's fix for LOG-F1's false-positive proximity window) requires the label word to sit immediately before the value with only a continuation, optional quote and a single ':'/'=' connector between them. This over-corrects: it now misses a real labelled secret whenever an ordinary filler word sits between the label and the connector ('password IS: <secret>'), or when the label and the value are on different lines, and the label look-back is explicitly bounded to the current line.
- Why it was dismissed: refuted by review-verifier (execution): bun -e against 536a6971 (content-identical to PR #781 head 22478bc0a9970324373cbe38fb5fd7e34568f64c), all three constructions from the finding's own filed evidence: (1) detectEntropy('password is: kd8Fj2LmQp9xZr4TvWn7Yb3xxyyzz') -> 1 match (was []); (2) detectEntropy('export API_KEY=\\\n' + 'kd8Fj2LmQp9xZr4TvWn7Yb3xxyyzz') -> 1 match (was []); (3) detectEntropy('password is:\n' + 'kd8Fj2LmQp9xZr4TvWn7Yb3xxyyzz') -> still [] (unchanged). Construction (3), a label ending the PREVIOUS line with no explicit continuation marker, is a documented, accepted residual, pinned by entropy.test.ts:409 ('does NOT regress: a label on the PREVIOUS line with no continuation marker stays a residual (not adjacent)'), which asserts the same [] result and is green at 536a6971. bun test src/security/detect/entropy.test.ts -t "LOG-F2" -> 6 pass, 0 fail. The verdict covers the finding as filed: two of its three filed constructions no longer reproduce, and the third is the pinned, accepted residual, not an unnoticed miss.
- Attested by: verifier — review-verifier (execution): bun -e against 536a6971 (content-identical to PR #781 head 22478bc0a9970324373cbe38fb5fd7e34568f64c), all three constructions from the finding's own filed evidence: (1) detectEntropy('password is: kd8Fj2LmQp9xZr4TvWn7Yb3xxyyzz') -> 1 match (was []); (2) detectEntropy('export API_KEY=\\\n' + 'kd8Fj2LmQp9xZr4TvWn7Yb3xxyyzz') -> 1 match (was []); (3) detectEntropy('password is:\n' + 'kd8Fj2LmQp9xZr4TvWn7Yb3xxyyzz') -> still [] (unchanged). Construction (3), a label ending the PREVIOUS line with no explicit continuation marker, is a documented, accepted residual, pinned by entropy.test.ts:409 ('does NOT regress: a label on the PREVIOUS line with no continuation marker stays a residual (not adjacent)'), which asserts the same [] result and is green at 536a6971. bun test src/security/detect/entropy.test.ts -t "LOG-F2" -> 6 pass, 0 fail. The verdict covers the finding as filed: two of its three filed constructions no longer reproduce, and the third is the pinned, accepted residual, not an unnoticed miss.

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
