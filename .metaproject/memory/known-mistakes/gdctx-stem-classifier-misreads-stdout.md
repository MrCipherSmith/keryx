# gdctx-stem-classifier-misreads-stdout

Version: 0.1.0
Type: known-mistake
Status: accepted
Confidence: high

## Summary

A keyword-stem classifier applied to raw stdout regardless of exit code turns ordinary English ("refuse," "cannot," "crash") into a false tool-failure signal. Gate stem-matching on stderr or a non-zero exit code, not on the words alone.

## Details

`keryx ctx run` and `keryx ctx rg` classify command output by matching English keyword stems in `FAILURE_STEMS` (regex `\b(fail|error|...|refus|reject|...)/i`). These stems are applied unconditionally to every line of stdout, regardless of the command's exit code or whether stderr contained any output.

This causes ordinary English in commit messages, documentation, or code comments — any line containing "refuse," "reject," "cannot," "crash" — to be mislabeled as an error even when the command succeeded (exit code 0, zero stderr bytes).

**Reproduction:** `keryx ctx run -- printf 'refuse this\n'` (exit 0, stderr empty) produces output that duplicates "refuse this" into both "Errors / Warnings" and "Output" sections, actively misleading an agent into treating a clean command as failed.

**Root cause:** `src/ctx/lines.ts:46` applies `FAILURE_STEMS` unconditionally via `classifyLine` (`src/ctx/lines.ts:73-82`), which receives a flat array of merged stdout/stderr lines with no stream provenance.

**Fix shape:** Make classification stream- and exit-code aware:
- Tag every line with its source stream (stdout | stderr) before ranking
- Demote `FAILURE_STEMS` to stderr-only, or gate it on the command's own exit code being non-zero
- Keep `REPO_FAILURE_MARKERS` (e.g., `(fail)`, `✗`) stream-agnostic — they are explicit tool-chosen glyphs
- Update every call site in `src/commands/ctx.ts` to pass `{ stream, exitCode }` context per line instead of bare strings
- Add regression fixture: `git log --oneline` with a "refuse" commit message, exit 0, zero stderr → must yield zero "Errors / Warnings" lines

## Provenance

- Source: flow 304 (W7 gdgraph/gdctx correctness)
- Link: docs/requirements/keryx-agent-platform-expansion/workstreams/W7-graph-ctx-correctness.md (GDCTX-1)
- Confirmed-By: Reproduced this session via `keryx ctx run -- printf 'refuse this\n'`
- Created: 2026-09-24
- Updated: 2026-09-24

## Related Scopes

- Module: ctx, classification, output-analysis
- Entity: classifyLine, importantLines, compactLines, FAILURE_STEMS
- Files:
  - `src/ctx/lines.ts` (classifyLine, rankByVerdict)
  - `src/commands/ctx.ts` (summarizeCommandOutput)
- Skills:

## Tags

gdctx, classification, stdout, error-detection, false-positive

## Changelog

- 0.1.0 - Initial version documenting GDCTX-1 defect from W7 correctness investigation.
