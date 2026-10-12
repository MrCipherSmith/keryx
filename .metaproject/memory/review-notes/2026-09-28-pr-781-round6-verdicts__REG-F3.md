# Review finding 2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#REG-F3 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-regression raised 2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#REG-F3 (major) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#REG-F3` (display id `REG-F3`)
- Reviewer: `review-regression`
- Severity: `major`
- Location: `src/security/redact.ts`
- Origin: `internal`
- What it claimed: This diff wires detectEntropy into redactSensitiveText (S-6) and into the new containsOutboundSecret (S-8) unconditionally -- neither threads a config/cwd parameter, so neither can consult SecurityConfig.backends.entropy.enabled. The only existing gate for detectEntropy is runDetectors (src/security/detect/index.ts:36), which keryx security scan/report/gate go through.
- Why it was dismissed: refuted by review-verifier (execution): bun test src/harness/web/outbound-secret.test.ts -t "F-REG-F3" at 536a6971 -> 2 pass, 0 fail; bun test src/security/redact.test.ts -t "F-REG-F3" -> 3 pass, 0 fail. Both describe blocks directly exercise backends.entropy.enabled gating containsOutboundSecret/redactSensitiveText via src/security/entropy-gate.ts's setEntropyBackendEnabledForTests, matching the finding's own recorded disposition.
- Attested by: verifier — review-verifier (execution): bun test src/harness/web/outbound-secret.test.ts -t "F-REG-F3" at 536a6971 -> 2 pass, 0 fail; bun test src/security/redact.test.ts -t "F-REG-F3" -> 3 pass, 0 fail. Both describe blocks directly exercise backends.entropy.enabled gating containsOutboundSecret/redactSensitiveText via src/security/entropy-gate.ts's setEntropyBackendEnabledForTests, matching the finding's own recorded disposition.

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
