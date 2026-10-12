# Review finding 2026-09-28-pr-776-round2-2a2db6b7#SEC-F2 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-security-code raised 2026-09-28-pr-776-round2-2a2db6b7#SEC-F2 (major) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-28-pr-776-round2-2a2db6b7#SEC-F2` (display id `SEC-F2`)
- Reviewer: `review-security-code`
- Severity: `major`
- Location: `src/security/detect/entropy.ts`:511
- Origin: `internal`
- What it claimed: Continuation of round-1 F-SEC-F2. The fixed label-overrides-allow-shape logic is correct, but bareShapeQualifies's own entropy floor (3.6 bits, no hex-blob match possible for a hyphenated UUID) runs BEFORE the label is ever consulted, so whether a labelled UUID is redacted depends entirely on that UUID's own digit repetition, independent of the label.
- Why it was dismissed: refuted by review-verifier (execution): bun -e against 536a6971: redactSensitiveText('leaked credential: 550e8400-e29b-41d4-a716-446655440000') -> 'leaked credential: [REDACTED:entropy]' (was unchanged; entropy 3.39, below the 3.6 floor). A second below-floor UUID (6ba7b810-9dad-11d1-80b4-00c04fd430c8) redacts the same way. bun test src/security/redact.test.ts -t "F-SEC-F2" run 5 times -> 5/5 pass, 0 fail. Fixed by PR #776 (ed1c3ba6), an ancestor of current main 536a6971.
- Attested by: verifier — review-verifier (execution): bun -e against 536a6971: redactSensitiveText('leaked credential: 550e8400-e29b-41d4-a716-446655440000') -> 'leaked credential: [REDACTED:entropy]' (was unchanged; entropy 3.39, below the 3.6 floor). A second below-floor UUID (6ba7b810-9dad-11d1-80b4-00c04fd430c8) redacts the same way. bun test src/security/redact.test.ts -t "F-SEC-F2" run 5 times -> 5/5 pass, 0 fail. Fixed by PR #776 (ed1c3ba6), an ancestor of current main 536a6971.

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
