# Review finding 2026-09-27-ingest-861be8c20e366df1c1a6eea22728ab2e0d2a886e#T4 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-testing-practices raised 2026-09-27-ingest-861be8c20e366df1c1a6eea22728ab2e0d2a886e#T4 (minor) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-27-ingest-861be8c20e366df1c1a6eea22728ab2e0d2a886e#T4` (display id `T4`)
- Reviewer: `review-testing-practices`
- Severity: `minor`
- Location: `src/cli.test.ts`
- Origin: `internal`
- What it claimed: The test's own name and preceding comment claim to cover comma-joined, path and pattern first positionals, but the guard under test only ever inspects args[1]; cases 2-4 put a plain bare word already known to that group's subcommand list at args[1], so only case 1 (integrate's comma-joined list) exercised the guard at all.
- Why it was dismissed: refuted by review-verifier (execution): Fix commit 70538bea replaces the round-3 test with `test("a group whose first positional is a comma-joined list is not in the map and is never refused")`, which asserts `[...groupsWithKnownSubcommands()]` does not contain `integrate` and then runs `integrate cursor,claude --dry-run` expecting exit 0 and no `Unknown command` on stderr. Ran `bun test src/cli.test.ts` in /home/altsay/keryx-w5 at 70538bea: 68 pass, 0 fail, 309 expect() calls. Mutation check: edited src/lib/group-subcommands.ts to re-add `["integrate", ["cursor","claude","opencode","vscode","generic","all"]]`, ran `bun test src/cli.test.ts -t "comma-joined list is not in the map"` -> 0 pass, 1 fail, failing on `expect([...groupsWithKnownSubcommands()]).not.toContain("integrate")` with the map now containing "integrate". Reverted the edit; `git status --porcelain` in the worktree shows no diff from before the check (only the pre-existing untracked `.metaproject/data/governance/`). The round-3 claim (that the test's path/pattern cases proved nothing) no longer applies to the current test, which now asserts the one real regression shape directly and is confirmed to fail without the fix.
- Attested by: verifier — review-verifier (execution): Fix commit 70538bea replaces the round-3 test with `test("a group whose first positional is a comma-joined list is not in the map and is never refused")`, which asserts `[...groupsWithKnownSubcommands()]` does not contain `integrate` and then runs `integrate cursor,claude --dry-run` expecting exit 0 and no `Unknown command` on stderr. Ran `bun test src/cli.test.ts` in /home/altsay/keryx-w5 at 70538bea: 68 pass, 0 fail, 309 expect() calls. Mutation check: edited src/lib/group-subcommands.ts to re-add `["integrate", ["cursor","claude","opencode","vscode","generic","all"]]`, ran `bun test src/cli.test.ts -t "comma-joined list is not in the map"` -> 0 pass, 1 fail, failing on `expect([...groupsWithKnownSubcommands()]).not.toContain("integrate")` with the map now containing "integrate". Reverted the edit; `git status --porcelain` in the worktree shows no diff from before the check (only the pre-existing untracked `.metaproject/data/governance/`). The round-3 claim (that the test's path/pattern cases proved nothing) no longer applies to the current test, which now asserts the one real regression shape directly and is confirmed to fail without the fix.

Only `dismissed-incorrect` reaches this folder. `dismissed-wont-fix`,
`dismissed-out-of-scope` and `dismissed-deprioritised` describe findings that
were CORRECT and were not acted on; counting them here would teach the reviewer
to stop raising true findings.

## Provenance

- Source: review
- Link: .metaproject/flows/353-2026-09-27-p0-w5-first-hour-keryx-doctor-did-you-me/reviews/2026-09-27-ingest-origin-main-70538bea
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
- round:2026-09-27-ingest-origin-main-70538bea
- commit:f2ee4c8896dde3402c57a8c8544f75544289d0b2

## Changelog

- 0.1.0 - Written by `keryx review` when the finding was dismissed as incorrect.
