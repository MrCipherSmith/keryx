# The keryx on PATH is a stale build; the review pipeline does not exercise the code under review

Version: 0.1.0
Type: constraint
Status: accepted
Confidence: high

## Summary

`/home/altsay/.local/bin/keryx` is an installed build reporting version `0.1.0`.
It is NOT the working tree. Every `keryx …` invocation — including
`keryx review ingest`, which is how a managed review package is recorded — runs
that build, so the review pipeline routinely does not exercise the code being
reviewed.

## Details

Found while ingesting the fix-round review of PR #220, and it failed in the two
ways a stale tool fails:

1. **Silently.** The consolidated report used `B-NNN` and `M-NNN` identifiers for
   readability. The parser only recognises `F-\d{3,}`, so the ingest produced
   **zero findings and reported success** — a ten-finding review recorded as an
   empty package with no warning. A report that ingests as nothing should not be
   a quiet outcome, and today it is.
2. **Wrongly.** Renumbered to `F-NNN`, the installed build then refused three
   findings for missing `class_scope` and misreported one major as a blocker.
   The same report through the working tree ingests as ten findings, correct
   severities, `class_scope` present on all ten, zero phantoms.

So the parser fix landed in this very round was not the parser that ran. The
guard refusing findings without `class_scope` is real and working — it was
applying an older `hasClassScope`/`FINDING_HEADING` pair against a report written
for the current one.

## How to apply

- For anything that must exercise the CURRENT source — the review pipeline above
  all, since it is what judges the source — invoke through the working tree:

  ```bash
  bun run keryx -- review ingest --target report --ref <report> --report <report>
  ```

  `keryx …` on PATH is fine for navigation (`ctx rg`, `gdgraph`, `flow`), where
  a stale build costs nothing.

- After changing anything under `src/review/`, `src/memory/` or `src/standard/`,
  assume the installed CLI does not have it until reinstalled.

- Never read a zero-finding ingest as "the report was clean". Check
  `findings.json` length against the report's own heading count. The fix-round
  report had ten headings and produced an empty array, and nothing said so.

## Related

- The per-finding drafts `memory ingest --from-review` creates are one file per
  finding, and it also creates files from JSON FIELD VALUES — `review-orchestrator`,
  `valid-followup` and `standalone-review` were all created as "lessons" from the
  `reviewer`, `classification` and `flow_relevance` fields. Delete those and
  write the pattern instead; a per-finding lesson is stale the moment the finding
  is fixed.

## Provenance

- Source: fix-round review of PR #220 (flow 133)
- Link: https://github.com/MrCipherSmith/keryx/pull/220
- Created: 2026-08-02
- Updated: 2026-08-02

## Related Scopes

- Module: review, memory
- Entity: managed-review-package
- Files: src/review/managed.ts, src/memory/ingest.ts, src/cli.ts
- Skills: review-orchestrator, memory

## Tags

tooling, review, ingest, stale-build, silent-failure

## Changelog

- 0.1.0 - Initial version. Found while ingesting the PR #220 fix-round review:
  zero findings recorded silently for non-`F-` identifiers, then three refused
  and one misgraded once renumbered, because the installed build predates the
  parser fix in the branch under review.
