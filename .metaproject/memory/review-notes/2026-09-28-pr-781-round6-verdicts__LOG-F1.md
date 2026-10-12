# Review finding 2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#LOG-F1 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-logic raised 2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#LOG-F1 (blocker) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#LOG-F1` (display id `LOG-F1`)
- Reviewer: `review-logic`
- Severity: `blocker`
- Location: `src/security/detect/entropy.ts`:359
- Origin: `internal`
- What it claimed: The entropy detector's TOKEN regex includes '/' in its character class, so applied to a URL it does not stop at path separators: an entire host/path/segments/<hex> run becomes one compound candidate. This defeats the git-SHA/UUID/integrity allow-shapes (which only match an isolated value, not a compound blob containing it) and makes SENSITIVE_LABEL's bare substring match fire on ordinary text like the hostname 'api.github.com'. Independently confirmed by review-regression (RG-1) from the outbound-refusal angle.
- Why it was dismissed: refuted by review-verifier (execution): bun -e against 536a6971: redactSensitiveText on the finding's own GitHub commit URL (https://api.github.com/repos/foo/bar/commits/<40-hex>) no longer mangles it (returns the URL unchanged, was '.../api.github.[REDACTED:entropy]'); containsOutboundSecret on the same URL and on the finding's ordinary secret-free webhook URL both now return false (were true/refused). bun test src/security/detect/entropy.test.ts -t "F-LOG-F1" -> 5 pass, 0 fail.
- Attested by: verifier — review-verifier (execution): bun -e against 536a6971: redactSensitiveText on the finding's own GitHub commit URL (https://api.github.com/repos/foo/bar/commits/<40-hex>) no longer mangles it (returns the URL unchanged, was '.../api.github.[REDACTED:entropy]'); containsOutboundSecret on the same URL and on the finding's ordinary secret-free webhook URL both now return false (were true/refused). bun test src/security/detect/entropy.test.ts -t "F-LOG-F1" -> 5 pass, 0 fail.

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
