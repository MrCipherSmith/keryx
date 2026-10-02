# Review finding 2026-09-27-ingest-e0be2cfd6640612e5b65f3f557fce9ab41e69f42#T3 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-testing-practices raised 2026-09-27-ingest-e0be2cfd6640612e5b65f3f557fce9ab41e69f42#T3 (minor) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-27-ingest-e0be2cfd6640612e5b65f3f557fce9ab41e69f42#T3` (display id `T3`)
- Reviewer: `review-testing-practices`
- Severity: `minor`
- Location: `src/cli.test.ts`
- Origin: `internal`
- What it claimed: cli.test.ts's coverage for the central 'unknown subcommand' guard (describe block for review round 1 L1) proved the negative case (a nonsense token is refused) for all 40 groups, but only two positive real-subcommand invocations were exercised ('keryx health status', 'keryx wiki ask --help'), and neither used a value shaped any differently from a single bare word.
- Why it was dismissed: refuted by review-verifier (execution): `bun test src/cli.test.ts` at cbbbe29f36fac4a3305ce1b5548bfa8ce3063079 (~/keryx, tree identical to origin/main 503c20c6) -> 68 pass, 0 fail. `keryx ctx rg "comma-joined" src/cli.test.ts` confirms the positive guard test named by T3's suggested_fix exists at src/cli.test.ts:337 -- "a group whose first positional is a comma-joined list is not in the map and is never refused" -- exercising integrate's comma-joined form. Added by commit 861be8c20e366df1c1a6eea22728ab2e0d2a886e. No longer reproduces at this head.
- Attested by: verifier — review-verifier (execution): `bun test src/cli.test.ts` at cbbbe29f36fac4a3305ce1b5548bfa8ce3063079 (~/keryx, tree identical to origin/main 503c20c6) -> 68 pass, 0 fail. `keryx ctx rg "comma-joined" src/cli.test.ts` confirms the positive guard test named by T3's suggested_fix exists at src/cli.test.ts:337 -- "a group whose first positional is a comma-joined list is not in the map and is never refused" -- exercising integrate's comma-joined form. Added by commit 861be8c20e366df1c1a6eea22728ab2e0d2a886e. No longer reproduces at this head.

Only `dismissed-incorrect` reaches this folder. `dismissed-wont-fix`,
`dismissed-out-of-scope` and `dismissed-deprioritised` describe findings that
were CORRECT and were not acted on; counting them here would teach the reviewer
to stop raising true findings.

## Provenance

- Source: review
- Link: .metaproject/flows/353-2026-09-27-p0-w5-first-hour-keryx-doctor-did-you-me/reviews/2026-09-27-ingest-origin-main-cbbbe29f36fac4a3305ce1b5548b-r02
- Created: 2026-09-27
- Updated: 2026-09-27

## Related Scopes

- Module:
- Entity:
- Files:
- Skills:

## Tags

- review-note
- false-positive
- round:2026-09-27-ingest-origin-main-cbbbe29f36fac4a3305ce1b5548b-r02
- commit:cbbbe29f36fac4a3305ce1b5548bfa8ce3063079

## Changelog

- 0.1.0 - Written by `keryx review` when the finding was dismissed as incorrect.
