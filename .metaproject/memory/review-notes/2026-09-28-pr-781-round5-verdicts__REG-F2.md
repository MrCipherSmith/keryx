# Review finding 2026-09-28-pr-779-round3-9b0b3f58#REG-F2 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-regression raised 2026-09-28-pr-779-round3-9b0b3f58#REG-F2 (major) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-28-pr-779-round3-9b0b3f58#REG-F2` (display id `REG-F2`)
- Reviewer: `review-regression`
- Severity: `major`
- Location: `src/security/detect/entropy.ts`:371
- Origin: `internal`
- What it claimed: REG-F1 (round 2) is only partially fixed. isSlugHexTail correctly carves out a hex tail that is the LAST segment of an already-valid word-slug (fixes Medium's '<words>-<hex>' shape), but a GitHub Gist URL's real, common shape is 'gist.github.com/<user>/<32-hex-id>' — the id is a SINGLE path segment with no internal hyphenation, so it never reaches isWordSlug at all (segments.length < 3 short-circuit). That segment falls straight to bareShapeQualifies's unconditional isHexBlob check.
- Why it was dismissed: refuted by review-verifier (execution): bun -e against 536a6971 (content-identical to PR #781 head 22478bc0a9970324373cbe38fb5fd7e34568f64c): containsOutboundSecret('https://gist.github.com/someuser/a1b2c3d4e5f67890abcdef1234567890') -> false (was true/refused). bun test src/harness/web/outbound-secret.test.ts -t "REG-F2" -> 8 pass, 0 fail.
- Attested by: verifier — review-verifier (execution): bun -e against 536a6971 (content-identical to PR #781 head 22478bc0a9970324373cbe38fb5fd7e34568f64c): containsOutboundSecret('https://gist.github.com/someuser/a1b2c3d4e5f67890abcdef1234567890') -> false (was true/refused). bun test src/harness/web/outbound-secret.test.ts -t "REG-F2" -> 8 pass, 0 fail.

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
