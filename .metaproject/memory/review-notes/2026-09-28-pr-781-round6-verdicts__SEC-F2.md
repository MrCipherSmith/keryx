# Review finding 2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#SEC-F2 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-security-code raised 2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#SEC-F2 (major) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#SEC-F2` (display id `SEC-F2`)
- Reviewer: `review-security-code`
- Severity: `major`
- Location: `src/security/detect/entropy.ts`
- Origin: `internal`
- What it claimed: The S-6/S-9 allow-shapes are checked by shape alone with no provenance signal, applied even when an explicit sensitive label sits directly next to the value. A real secret that happens to be 40/7-12 hex chars, a UUID, or an npm/yarn integrity-shaped string is unconditionally exempted from redaction and from displayUrl masking.
- Why it was dismissed: refuted by review-verifier (execution): bun -e against 536a6971: redactSensitiveText('leaked token: ' + <40-hex full SHA>) -> [REDACTED:entropy] (was unchanged); redactSensitiveText('leaked token: ' + <npm sha512- integrity string>) -> [REDACTED:entropy] (was unchanged). The finding's own recorded disposition already notes its UUID sub-case is a SEPARATE finding (round 2's own SEC-F2, global_id 2026-09-28-pr-776-round2-2a2db6b7#SEC-F2), verified and closed separately in round 5 of this flow. The finding's short-SHA (7-char) sub-case is unreachable regardless of this fix, per LOG-F2 (same round, same package): SHORT_GIT_SHA_RE was always dead code below the entropy/length floors, confirmed by keryx ctx rg finding no remaining definition, only explanatory comments.
- Attested by: verifier — review-verifier (execution): bun -e against 536a6971: redactSensitiveText('leaked token: ' + <40-hex full SHA>) -> [REDACTED:entropy] (was unchanged); redactSensitiveText('leaked token: ' + <npm sha512- integrity string>) -> [REDACTED:entropy] (was unchanged). The finding's own recorded disposition already notes its UUID sub-case is a SEPARATE finding (round 2's own SEC-F2, global_id 2026-09-28-pr-776-round2-2a2db6b7#SEC-F2), verified and closed separately in round 5 of this flow. The finding's short-SHA (7-char) sub-case is unreachable regardless of this fix, per LOG-F2 (same round, same package): SHORT_GIT_SHA_RE was always dead code below the entropy/length floors, confirmed by keryx ctx rg finding no remaining definition, only explanatory comments.

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
