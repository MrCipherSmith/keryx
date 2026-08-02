# gdctx rg summary

Command: `rg --line-number --column --no-heading -- 222|349|173`
Exit code: `0`
Matches: `3`
Files: `2`
Raw lines: `3`

## Top Files

- round4-review.md: 2
- round3-review.md: 1

## Matches

- round4-review.md
  - 42:29 | stdout table control row `173B` | 222B — and my own "was 349B" in the same table proves it, since 349 = 222 + 127. The two rows the fix was about were instrumented; the contro...
  - 193:35 - The stdout table's control row `173B` should be `222B`.
- round3-review.md
  - 100:9 stdout: 349 bytes, of which the last line is {"permission":"deny",…}

## Metadata

```json
{
  "id": "2026-08-02T20-24-59-618Z_rg",
  "kind": "rg",
  "command": "rg --line-number --column --no-heading -- 222|349|173",
  "exitCode": 0,
  "rawPath": ".metaproject/data/gdctx/raw/2026-08-02T20-24-59-618Z_rg.log",
  "summaryPath": ".metaproject/data/gdctx/artifacts/2026-08-02T20-24-59-618Z_rg.md",
  "bytesIn": 412,
  "bytesOut": 594,
  "truncated": false
}
```
