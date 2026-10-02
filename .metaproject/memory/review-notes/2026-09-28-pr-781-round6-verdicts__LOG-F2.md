# Review finding 2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#LOG-F2 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-logic raised 2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#LOG-F2 (minor) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#LOG-F2` (display id `LOG-F2`)
- Reviewer: `review-logic`
- Severity: `minor`
- Location: `src/security/detect/entropy.ts`
- Origin: `internal`
- What it claimed: AC2 and the CHANGELOG/findings.md narrative claim a '7-12-hex short SHA' allow-shape, but it is unreachable in both callers: detectEntropy's TOKEN regex requires a 20+ char head before any candidate is considered, and looksSecretShaped is only invoked on segments of 16+ chars -- both above the 7-12 range.
- Why it was dismissed: refuted by review-verifier (site-check): keryx ctx rg "SHORT_GIT_SHA_RE" src/security/detect/entropy.ts at 536a6971 -> 2 matches, both explanatory comments (lines 49, 381) naming F-LOG-F2, no remaining regex definition or reachable code path — matches the finding's own recorded disposition that the branch was removed.
- Attested by: verifier — review-verifier (site-check): keryx ctx rg "SHORT_GIT_SHA_RE" src/security/detect/entropy.ts at 536a6971 -> 2 matches, both explanatory comments (lines 49, 381) naming F-LOG-F2, no remaining regex definition or reachable code path — matches the finding's own recorded disposition that the branch was removed.

Only `dismissed-incorrect` reaches this folder. `dismissed-wont-fix`,
`dismissed-out-of-scope` and `dismissed-deprioritised` describe findings that
were CORRECT and were not acted on; counting them here would teach the reviewer
to stop raising true findings.

## Provenance

- Source: review
- Link: .metaproject/flows/355-2026-09-28-audit-remediation-2-security-depth-entro/reviews/2026-09-28-pr-781-round6-verdicts
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
- round:2026-09-28-pr-781-round6-verdicts
- commit:22478bc0a9970324373cbe38fb5fd7e34568f64c

## Changelog

- 0.1.0 - Written by `keryx review` when the finding was dismissed as incorrect.
