# Review finding 2026-09-22-ingest-acp-live#F-006 was dismissed as incorrect

Version: 0.1.0
Type: review-note
Status: draft
Confidence: medium

## Summary

code-reviewer (acp) raised 2026-09-22-ingest-acp-live#F-006 (minor) and the round recorded it as `dismissed-incorrect` — the one disposition that says the reviewer was wrong.

## Details

- Finding: `2026-09-22-ingest-acp-live#F-006` (display id `F-006`)
- Reviewer: `code-reviewer (acp)`
- Severity: `minor`
- Location: `src/acp/session-mcp.ts`
- Origin: `internal`
- What it claimed: Question raised: could a client ever be offered `allow_always` for a call to a client-supplied MCP tool, bypassing the per-call permission ask AC4 requires?
- Why it was dismissed: no allow_always path exists for a client MCP tool call — use_tool is unconditionally destructive, so this finding's premise does not hold. No code change was needed; confirmed against the code merged to main in 4aba62bc via PR #648.
- Attested by: verifier — orchestrator (flow 287 close-out) (execution): use_tool unconditionally carries meta.destructive=true, so allow_always is never offered for a client MCP tool call; pinned by the AC7 process test in src/acp/mcp-servers.process.test.ts and by src/acp/session-mcp.test.ts test 'use_tool is destructive, so every call reaches the agent's approval branch (AC4)'. No code change was required. Confirmed against the code merged to main in 4aba62bc via PR #648, CI 18/18 green at a559059d.

Only `dismissed-incorrect` reaches this folder. `dismissed-wont-fix`,
`dismissed-out-of-scope` and `dismissed-deprioritised` describe findings that
were CORRECT and were not acted on; counting them here would teach the reviewer
to stop raising true findings.

## Provenance

- Source: review
- Link: .metaproject/flows/287-2026-09-22-acp-live-client-fixes-real-provider-by-d/reviews/2026-09-22-ingest-acp-live
- Created: 2026-09-22
- Updated: 2026-09-22

## Related Scopes

- Module:
- Entity:
- Files:
- Skills:

## Tags

- review-note
- false-positive
- round:2026-09-22-ingest-acp-live
- commit:a559059d84ae10c20d92bc3f1366cfa0a530ff6e

## Changelog

- 0.1.0 - Written by `keryx review` when the finding was dismissed as incorrect.
