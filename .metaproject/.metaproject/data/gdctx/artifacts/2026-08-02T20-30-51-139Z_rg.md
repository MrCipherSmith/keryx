# gdctx rg summary

Command: `rg --line-number --column --no-heading -- four places|in four places`
Exit code: `0`
Matches: `13`
Files: `11`
Raw lines: `13`

## Top Files

- data/gdctx/raw/2026-08-02T15-29-19-137Z_diff.log: 3
- memory/lessons/regex-guards-lose-to-spellings.md: 1
- flows/133-2026-08-01-fix-round-pr220/round4-review.md: 1
- data/gdctx/raw/2026-08-02T20-30-51-039Z_rg.log: 1
- data/gdctx/raw/2026-08-02T15-46-36-211Z_run.log: 1
- data/gdctx/raw/2026-08-02T18-29-37-178Z_run.log: 1
- data/gdctx/raw/latest.log: 1
- data/gdctx/artifacts/2026-08-02T18-29-37-178Z_run.md: 1
- data/gdctx/artifacts/latest.md: 1
- data/gdctx/artifacts/2026-08-02T20-30-51-039Z_rg.md: 1
- data/gdctx/artifacts/2026-08-02T15-46-36-211Z_run.md: 1

## Matches

- data/gdctx/raw/2026-08-02T15-29-19-137Z_diff.log
  - 163:47 +writes `await import("…/shell-config.ts")` in four places. The guard living in
  - 753:9 +    // four places. It is the file's own idiom.
  - 1336:59 +    // file writes `await import("…/shell-config.ts")` in four places. The guard
- memory/lessons/regex-guards-lose-to-spellings.md
  - 39:46 writes `await import("…/shell-config.ts")` in four places. The guard living in
- flows/133-2026-08-01-fix-round-pr220/round4-review.md
  - 215:38 "`await import(…/shell-config.ts)` in four places" — it appears once; four
- data/gdctx/raw/2026-08-02T20-30-51-039Z_rg.log
  - 2:100 src/lib/config-dir.readers.test.ts:667:39:    // file writes `await import("…/shell-config.ts")` in four places. The guard
- data/gdctx/raw/2026-08-02T15-46-36-211Z_run.log
  - 32:59 +    // file writes `await import("…/shell-config.ts")` in four places. The guard
- data/gdctx/raw/2026-08-02T18-29-37-178Z_run.log
  - 32:59 +    // file writes `await import("…/shell-config.ts")` in four places. The guard
- data/gdctx/raw/latest.log
  - 2:100 src/lib/config-dir.readers.test.ts:667:39:    // file writes `await import("…/shell-config.ts")` in four places. The guard
- data/gdctx/artifacts/2026-08-02T18-29-37-178Z_run.md
  - 44:59 +    // file writes `await import("…/shell-config.ts")` in four places. The guard
- data/gdctx/artifacts/latest.md
  - 17:65 - 667:39 // file writes `await import("…/shell-config.ts")` in four places. The guard
- data/gdctx/artifacts/2026-08-02T20-30-51-039Z_rg.md
  - 17:65 - 667:39 // file writes `await import("…/shell-config.ts")` in four places. The guard
- data/gdctx/artifacts/2026-08-02T15-46-36-211Z_run.md
  - 53:59 +    // file writes `await import("…/shell-config.ts")` in four places. The guard

## Metadata

```json
{
  "id": "2026-08-02T20-30-51-139Z_rg",
  "kind": "rg",
  "command": "rg --line-number --column --no-heading -- four places|in four places",
  "exitCode": 0,
  "rawPath": ".metaproject/data/gdctx/raw/2026-08-02T20-30-51-139Z_rg.log",
  "summaryPath": ".metaproject/data/gdctx/artifacts/2026-08-02T20-30-51-139Z_rg.md",
  "bytesIn": 1831,
  "bytesOut": 2555,
  "truncated": false
}
```
