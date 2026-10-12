# Review finding 2026-09-28-pr-776-round2-2a2db6b7#SEC-F1 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-security-code raised 2026-09-28-pr-776-round2-2a2db6b7#SEC-F1 (blocker) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-28-pr-776-round2-2a2db6b7#SEC-F1` (display id `SEC-F1`)
- Reviewer: `review-security-code`
- Severity: `blocker`
- Location: `src/security/detect/entropy.ts`:462
- Origin: `internal`
- What it claimed: isWordSlug exempts a hyphen/underscore-segmented run from the entropy/hex-blob gate whenever every segment is pure-alpha, pure-digit, or a single-transition tag, with no check on the RECONSTITUTED value's own entropy. Re-segmenting any real secret into single-character-class chunks joined by '-' defeats looksSecretShaped/secretShapedCandidatesIn entirely.
- Why it was dismissed: refuted by review-verifier (execution): bun -e against 536a6971: the finding's own segmented-secret repro — looksSecretShaped('aK-9-dQ-2-rN-7-zVbT-4-pXeYfWmC-1-oLaHsJtU-8') -> true (was false); containsOutboundSecret on the same value in a URL path -> true (was false/not refused); redactSensitiveText('leaked api_key: ' + same value) -> [REDACTED:entropy] (was unchanged). The minimal-wrap variant containsOutboundSecret('https://x.example/log-abcdefghijklmnopqrstuvwxyzAB1234-id') -> true (was false); detectEntropy on the same URL -> 1 match (was []). bun test src/security/detect/entropy.test.ts -t "SEC-F1" -> 3 pass, 0 fail.
- Attested by: verifier — review-verifier (execution): bun -e against 536a6971: the finding's own segmented-secret repro — looksSecretShaped('aK-9-dQ-2-rN-7-zVbT-4-pXeYfWmC-1-oLaHsJtU-8') -> true (was false); containsOutboundSecret on the same value in a URL path -> true (was false/not refused); redactSensitiveText('leaked api_key: ' + same value) -> [REDACTED:entropy] (was unchanged). The minimal-wrap variant containsOutboundSecret('https://x.example/log-abcdefghijklmnopqrstuvwxyzAB1234-id') -> true (was false); detectEntropy on the same URL -> 1 match (was []). bun test src/security/detect/entropy.test.ts -t "SEC-F1" -> 3 pass, 0 fail.

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
