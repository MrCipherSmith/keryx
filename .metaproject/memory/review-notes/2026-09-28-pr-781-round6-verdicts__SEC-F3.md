# Review finding 2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#SEC-F3 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-security-code raised 2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#SEC-F3 (major) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#SEC-F3` (display id `SEC-F3`)
- Reviewer: `review-security-code`
- Severity: `major`
- Location: `src/security/credential-shape.ts`
- Origin: `internal`
- What it claimed: R-I2's anchoring fix (added this PR to stop GLUED_SECRET_RE over-matching APITOKENIZER) requires the (^|_) boundary immediately before the glued prefix. This stops the false positive but also means the check only protects the five compounds at the very start of a name or right after an underscore; gluing any other word in front with no underscore (a common naming convention) makes the whole check stop matching for KEY/TOKEN, SECRET/PASS(WD) compounds (SECRET_SUBSTRING_RE still catches the PASSWORD family unaffected).
- Why it was dismissed: refuted by review-verifier (execution): bun -e against 536a6971: isDeniedForMcpChild returns true (was false) for all eight of the finding's own prefixed constructions (PRODDBPASS, STAGEDBPASS, MYPRIVATEKEY, USERREFRESHTOKEN, LEGACYACCESSTOKEN, V2APITOKEN, OAUTHACCESSTOKEN, SNOWFLAKEDBPASS); the five unprefixed forms (PRIVATEKEY, REFRESHTOKEN, ACCESSTOKEN, APITOKEN, DBPASS) remain true; APITOKENIZER remains false, matching the finding's own stated 'intended' expectation.
- Attested by: verifier — review-verifier (execution): bun -e against 536a6971: isDeniedForMcpChild returns true (was false) for all eight of the finding's own prefixed constructions (PRODDBPASS, STAGEDBPASS, MYPRIVATEKEY, USERREFRESHTOKEN, LEGACYACCESSTOKEN, V2APITOKEN, OAUTHACCESSTOKEN, SNOWFLAKEDBPASS); the five unprefixed forms (PRIVATEKEY, REFRESHTOKEN, ACCESSTOKEN, APITOKEN, DBPASS) remain true; APITOKENIZER remains false, matching the finding's own stated 'intended' expectation.

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
