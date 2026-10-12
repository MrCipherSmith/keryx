# Review finding 2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#REG-F2 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-regression raised 2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#REG-F2 (major) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#REG-F2` (display id `REG-F2`)
- Reviewer: `review-regression`
- Severity: `major`
- Location: `src/mcp-servers/http-headers.ts`:351
- Origin: `internal`
- What it claimed: displayUrl's new per-path-segment masking calls looksSecretShaped with no label requirement, which falls back to HEX_BLOB = /^[0-9a-f]{24,}$/i whenever the entropy floor isn't met on its own. Decimal digits are a strict subset of the hex alphabet, so any purely-numeric string of 24+ characters satisfies HEX_BLOB regardless of actual entropy or credential likelihood.
- Why it was dismissed: refuted by review-verifier (execution): bun -e against 536a6971: looksSecretShaped('123456789012345678901234') (24 digits, the finding's own repro value) -> false (was true); a 30-digit variant -> false. bun test src/mcp-servers/http-headers.table.test.ts -t "BOUNDARY" -> 23 pass, 0 fail, including the finding's own named boundary rows.
- Attested by: verifier — review-verifier (execution): bun -e against 536a6971: looksSecretShaped('123456789012345678901234') (24 digits, the finding's own repro value) -> false (was true); a 30-digit variant -> false. bun test src/mcp-servers/http-headers.table.test.ts -t "BOUNDARY" -> 23 pass, 0 fail, including the finding's own named boundary rows.

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
