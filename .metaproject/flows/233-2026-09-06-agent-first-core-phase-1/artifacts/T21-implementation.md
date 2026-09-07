# T21 nested audit parser fix

Malformed recognized npm containers/entries and unsupported severities now invalidate parse coverage instead of silently becoming clean. Valid advisories are decoded independently and retained even when another entry is malformed. Wrong-shaped reserved npm containers cannot fall back to Bun format.

- RED: 9 pass, 3 fail; raw 2026-09-06T12-17-20-768Z_run.log.
- GREEN focused: 12 pass, 0 fail, 78 assertions; raw 2026-09-06T12-19-58-944Z_run.log.
- All health: 86 pass, 0 fail, 256 assertions; raw 2026-09-06T12-20-14-246Z_run.log.
- Scoped lint: PASS; raw 2026-09-06T12-20-12-267Z_run.log.

The runHealth regression uses a local fake audit binary and proves FAIL with coverage incomplete while preserving the valid P0 finding. No real package audit or network call occurred. Independent T16 recheck remains required before phase acceptance.
