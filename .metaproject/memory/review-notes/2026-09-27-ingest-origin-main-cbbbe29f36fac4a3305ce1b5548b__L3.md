# Review finding 2026-09-27-ingest-e0be2cfd6640612e5b65f3f557fce9ab41e69f42#L3 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

review-logic raised 2026-09-27-ingest-e0be2cfd6640612e5b65f3f557fce9ab41e69f42#L3 (blocker) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-27-ingest-e0be2cfd6640612e5b65f3f557fce9ab41e69f42#L3` (display id `L3`)
- Reviewer: `review-logic`
- Severity: `blocker`
- Location: `src/lib/group-subcommands.ts`
- Origin: `internal`
- What it claimed: The round-1 fix for L1 adds a central pre-dispatch 'unknown subcommand' guard in src/cli.ts (main()), driven by src/lib/group-subcommands.ts's GROUP_SUBCOMMANDS map. That map included the 'integrate' group with the closed enum [cursor, claude, opencode, vscode, generic, all] -- the individual editor names commands/integrate.ts's EDITOR_USAGE documents. But commands/integrate.ts's own parseEditors() (lines 51-58) explicitly treats the first positional as a comma-splittable LIST, not a single closed-vocabulary token: 'keryx integrate cursor,claude' is a documented, pre-existing, working invocation that addresses two editors in one call. The guard checked the raw token 'cursor,claude' against the per-editor enum, found no exact match, and refused the command with 'Unknown command: cursor,claude...' before integrateCommand ever ran -- breaking a real, currently-working invocation.
- Why it was dismissed: refuted by review-verifier (execution): `bun run src/cli.ts integrate cursor,claude --dry-run` at cbbbe29f36fac4a3305ce1b5548bfa8ce3063079 (~/keryx, tree identical to origin/main 503c20c6) -> exit 0, writes both `.cursor/mcp.json` and `.mcp.json` dry-run previews, no 'Unknown command' message. `keryx ctx rg "integrate" src/lib/group-subcommands.ts` shows no `integrate` row in GROUP_SUBCOMMANDS, only a comment (lines 181-182) explaining the deliberate exclusion. Fixed by commit 861be8c20e366df1c1a6eea22728ab2e0d2a886e, which removed the `integrate` row from GROUP_SUBCOMMANDS. No longer reproduces at this head.
- Attested by: verifier — review-verifier (execution): `bun run src/cli.ts integrate cursor,claude --dry-run` at cbbbe29f36fac4a3305ce1b5548bfa8ce3063079 (~/keryx, tree identical to origin/main 503c20c6) -> exit 0, writes both `.cursor/mcp.json` and `.mcp.json` dry-run previews, no 'Unknown command' message. `keryx ctx rg "integrate" src/lib/group-subcommands.ts` shows no `integrate` row in GROUP_SUBCOMMANDS, only a comment (lines 181-182) explaining the deliberate exclusion. Fixed by commit 861be8c20e366df1c1a6eea22728ab2e0d2a886e, which removed the `integrate` row from GROUP_SUBCOMMANDS. No longer reproduces at this head.

Only `dismissed-incorrect` reaches this folder. `dismissed-wont-fix`,
`dismissed-out-of-scope` and `dismissed-deprioritised` describe findings that
were CORRECT and were not acted on; counting them here would teach the reviewer
to stop raising true findings.

## Provenance

- Source: review
- Link: .metaproject/flows/353-2026-09-27-p0-w5-first-hour-keryx-doctor-did-you-me/reviews/2026-09-27-ingest-origin-main-cbbbe29f36fac4a3305ce1b5548b
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
- round:2026-09-27-ingest-origin-main-cbbbe29f36fac4a3305ce1b5548b
- commit:503c20c60ceb7755c389a6ce0ed7756b0537037a

## Changelog

- 0.1.0 - Written by `keryx review` when the finding was dismissed as incorrect.
