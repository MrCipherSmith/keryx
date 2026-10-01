# Review finding 2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#ARCH-F1 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-architecture raised 2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#ARCH-F1 (major) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-28-pr-origin-main-dc63b9bc0469580d726379f9a030-r02#ARCH-F1` (display id `ARCH-F1`)
- Reviewer: `review-architecture`
- Severity: `major`
- Location: `src/harness/external/env-deny.ts`
- Origin: `internal`
- What it claimed: This diff adds a new client-zone-imports-core-internal edge (harness/external/env-deny.ts -> security/credential-shape.ts), bypassing the security/service.ts facade, and permanently raises AVOIDABLE_BYPASS_CEILING from 150 to 151. The PR justifies this as 'structurally unavoidable' because credential-shape.ts (core) cannot import env-deny.ts (client) back -- true but irrelevant, since the actual bypass exists only because security/service.ts re-exports isDeniedForMcpChild from credential-shape.ts (added in this same diff) but was not also extended to re-export EXTERNAL_ENV_DENY/EXTERNAL_ENV_PREFIX_SWEEPS.
- Why it was dismissed: refuted by review-verifier (execution): Direct read of src/security/service.ts:97 at 536a6971: now re-exports EXTERNAL_ENV_DENY/EXTERNAL_ENV_PREFIX_SWEEPS alongside isDeniedForMcpChild; src/harness/external/env-deny.ts:14 re-exports both via that facade, not a direct core-internal import. bun test src/lib/import-policy.live.test.ts -> 13 pass, 0 fail, confirming AVOIDABLE_BYPASS_CEILING = 150 (the finding's own baseline; was raised to 151 pre-fix).
- Attested by: verifier — review-verifier (execution): Direct read of src/security/service.ts:97 at 536a6971: now re-exports EXTERNAL_ENV_DENY/EXTERNAL_ENV_PREFIX_SWEEPS alongside isDeniedForMcpChild; src/harness/external/env-deny.ts:14 re-exports both via that facade, not a direct core-internal import. bun test src/lib/import-policy.live.test.ts -> 13 pass, 0 fail, confirming AVOIDABLE_BYPASS_CEILING = 150 (the finding's own baseline; was raised to 151 pre-fix).

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
