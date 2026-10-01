# Review finding 2026-09-28-pr-779-round3-9b0b3f58#TEST-F1 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-testing-practices raised 2026-09-28-pr-779-round3-9b0b3f58#TEST-F1 (minor) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-28-pr-779-round3-9b0b3f58#TEST-F1` (display id `TEST-F1`)
- Reviewer: `review-testing-practices`
- Severity: `minor`
- Location: `src/security/redact.test.ts`:164
- Origin: `internal`
- What it claimed: src/security/redact.test.ts's 'F-SEC-F2 ... 20 random UUIDs' test draws unseeded crypto.randomUUID() values and asserts the unlabelled half are never redacted. This is flaky: one of the 20 random UUIDs can pass the pre-existing pii.credit-card Luhn check (unrelated to this PR's entropy.ts diff), producing a [REDACTED:cc] match on the 'unlabelled' assertion. Reproduced once in 4 runs.
- Why it was dismissed: refuted by review-verifier (execution): bun test src/security/redact.test.ts -t "F-SEC-F2" at 536a6971, run 5 times consecutively -> 5/5 pass, 0/5 fail (round 3 reproduced 1 failure in 4 runs pre-fix). Direct read of src/security/redact.test.ts confirms the UUID sample is now 20 fixed, committed UUIDs; crypto.randomUUID only appears in a comment, not in the generation path.
- Attested by: verifier — review-verifier (execution): bun test src/security/redact.test.ts -t "F-SEC-F2" at 536a6971, run 5 times consecutively -> 5/5 pass, 0/5 fail (round 3 reproduced 1 failure in 4 runs pre-fix). Direct read of src/security/redact.test.ts confirms the UUID sample is now 20 fixed, committed UUIDs; crypto.randomUUID only appears in a comment, not in the generation path.

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
