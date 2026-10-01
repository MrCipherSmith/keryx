# Review finding 2026-09-28-pr-779-round3-9b0b3f58#DOC-F2 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-testing-practices raised 2026-09-28-pr-779-round3-9b0b3f58#DOC-F2 (minor) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-28-pr-779-round3-9b0b3f58#DOC-F2` (display id `DOC-F2`)
- Reviewer: `review-testing-practices`
- Severity: `minor`
- Location: `CHANGELOG.md`:16
- Origin: `internal`
- What it claimed: CHANGELOG.md's [0.3.20] entry documents the four round-2 findings but has no line for this same PR's LABEL_ASSIGNMENT_RE (LABEL=VALUE assignments) and camelCase label-boundary fix. Both are genuine, user-facing behaviour changes shipped in this same diff, with their own tests, but with no changelog line.
- Why it was dismissed: refuted by review-verifier (site-check): Direct read of CHANGELOG.md at 536a6971: the [0.3.21] entry, line 14, reads 'Also shipped in 0.3.19-0.3.20: LABEL=VALUE assignment shapes (api_key=..., --token=...) and camelCase labels (apiKey: "...") are now recognised and redacted, closing a gap...' — the missing bullet the finding asked for is present.
- Attested by: verifier — review-verifier (site-check): Direct read of CHANGELOG.md at 536a6971: the [0.3.21] entry, line 14, reads 'Also shipped in 0.3.19-0.3.20: LABEL=VALUE assignment shapes (api_key=..., --token=...) and camelCase labels (apiKey: "...") are now recognised and redacted, closing a gap...' — the missing bullet the finding asked for is present.

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
