# Review finding 2026-09-28-pr-779-round3-9b0b3f58#SEC-F3 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-security-code raised 2026-09-28-pr-779-round3-9b0b3f58#SEC-F3 (blocker) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-28-pr-779-round3-9b0b3f58#SEC-F3` (display id `SEC-F3`)
- Reviewer: `review-security-code`
- Severity: `blocker`
- Location: `src/security/detect/entropy.ts`:457
- Origin: `internal`
- What it claimed: isSlugHexTail — added this round to fix REG-F1 — grants a hyphenated slug's LAST segment a content-free carve-out whenever it is a 10-16 character pure-hex run, with no check on whether that segment is itself the secret. Because bareShapeQualifies checks isWordSlug BEFORE any entropy/allow-shape/label logic, and labelledPieceQualifies (the LABELLED path, reached only after ADJACENT_LABEL already confirmed a label) calls bareShapeQualifies first and only falls back to isAllowShapedValue afterward, a real secret dressed as `<word>-<word>-<10to16-hex>` bypasses looksSecretShaped, containsOutboundSecret (S-8) and redactSensitiveText (S-6) completely — even when the value carries an explicit label right next to it.
- Why it was dismissed: refuted by review-verifier (execution): bun -e against 536a6971 (content-identical to PR #781 head 22478bc0a9970324373cbe38fb5fd7e34568f64c): the finding's own filed repro, redactSensitiveText('leaked api_key: log-report-deadbeef01234567'), returns 'leaked api_key: [REDACTED:entropy]' (was unchanged). bun test src/security/detect/entropy.test.ts -t "SEC-F3" -> 3 pass, 0 fail; bun test src/security/redact.test.ts -t "SEC-F3" -> 2 pass, 0 fail. The finding's impact text also named an UNLABELLED path and the outbound (S-8) path: direct execution confirms both remain unchanged from the original repro (looksSecretShaped('log-report-deadbeef01234567') -> false; containsOutboundSecret('https://exfil.example/log-report-deadbeef01234567') -> false) — this is a documented, accepted residual, not an unnoticed miss, pinned by entropy.test.ts:368 ('the same value, UNLABELLED, still passes — looksSecretShaped stays false (accepted residual, see findings.md S-8)') and outbound-secret.test.ts:126 ('an UNLABELLED word-slug-with-hex-tail (10-16 hex chars) still fetches'), both green at 536a6971. The verdict covers the finding as filed: its filed, labelled repro no longer reproduces.
- Attested by: verifier — review-verifier (execution): bun -e against 536a6971 (content-identical to PR #781 head 22478bc0a9970324373cbe38fb5fd7e34568f64c): the finding's own filed repro, redactSensitiveText('leaked api_key: log-report-deadbeef01234567'), returns 'leaked api_key: [REDACTED:entropy]' (was unchanged). bun test src/security/detect/entropy.test.ts -t "SEC-F3" -> 3 pass, 0 fail; bun test src/security/redact.test.ts -t "SEC-F3" -> 2 pass, 0 fail. The finding's impact text also named an UNLABELLED path and the outbound (S-8) path: direct execution confirms both remain unchanged from the original repro (looksSecretShaped('log-report-deadbeef01234567') -> false; containsOutboundSecret('https://exfil.example/log-report-deadbeef01234567') -> false) — this is a documented, accepted residual, not an unnoticed miss, pinned by entropy.test.ts:368 ('the same value, UNLABELLED, still passes — looksSecretShaped stays false (accepted residual, see findings.md S-8)') and outbound-secret.test.ts:126 ('an UNLABELLED word-slug-with-hex-tail (10-16 hex chars) still fetches'), both green at 536a6971. The verdict covers the finding as filed: its filed, labelled repro no longer reproduces.

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
