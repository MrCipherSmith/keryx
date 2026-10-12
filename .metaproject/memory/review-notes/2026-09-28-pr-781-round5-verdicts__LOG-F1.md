# Review finding 2026-09-28-pr-776-round2-2a2db6b7#LOG-F1 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-logic raised 2026-09-28-pr-776-round2-2a2db6b7#LOG-F1 (major) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-28-pr-776-round2-2a2db6b7#LOG-F1` (display id `LOG-F1`)
- Reviewer: `review-logic`
- Severity: `major`
- Location: `src/security/detect/entropy.ts`:359
- Origin: `internal`
- What it claimed: The generic (non-URL) per-line scan's TOKEN character class still includes '/' and '=', so a relative path, a code assignment, or a '/'-joined list is swept as one compound run; SENSITIVE_LABEL's 40-char lookback is same-line PROXIMITY, not true adjacency, so any ordinary occurrence of a label word earlier in the line/comment triggers a match on unrelated text.
- Why it was dismissed: refuted by review-verifier (execution): bun test src/security/redact.test.ts -t "F-LOG-F1" at 536a6971 -> 5 pass, 0 fail. Direct execution of the four original round-2 false-positive constructions (ADR relative link near 'Credential Masking', GitHub noreply-email local part near 'key', 'from_attributes=True' near 'API', a passlib/bcrypt/argon2 comment near 'password') via detectEntropy() -> 0 matches for all four (round 2 measured 5 FPs across these shapes in a git-log slice). Fixed by PR #776 (ed1c3ba6cb224bac4bed982a56b5da73585913d5), an ancestor of current main 536a6971.
- Attested by: verifier — review-verifier (execution): bun test src/security/redact.test.ts -t "F-LOG-F1" at 536a6971 -> 5 pass, 0 fail. Direct execution of the four original round-2 false-positive constructions (ADR relative link near 'Credential Masking', GitHub noreply-email local part near 'key', 'from_attributes=True' near 'API', a passlib/bcrypt/argon2 comment near 'password') via detectEntropy() -> 0 matches for all four (round 2 measured 5 FPs across these shapes in a git-log slice). Fixed by PR #776 (ed1c3ba6cb224bac4bed982a56b5da73585913d5), an ancestor of current main 536a6971.

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
