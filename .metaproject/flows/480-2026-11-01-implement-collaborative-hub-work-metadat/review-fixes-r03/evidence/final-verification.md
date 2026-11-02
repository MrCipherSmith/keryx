# Independent verification

STATUS: DONE_WITH_CONCERNS
Gate: **PASS_WITH_WARNINGS**
Base: `7e7179a8ab937703df49b6b14e89e5f9dd66eb96`

| Check | Command | Result | Raw log |
|---|---|---|---|
| root lint | `bun run lint` | pass: 0 errors, 0 warnings | `2026-11-02T13-06-57-367Z-32c820_run.log` |
| root typecheck | `bun run typecheck` | pass: 0 errors | `2026-11-02T13-06-44-547Z-e9bfb6_run.log` |
| scripts typecheck | `bun run typecheck:scripts` | pass: 0 errors | `2026-11-02T13-06-03-614Z-666467_run.log` |
| health | `bun run src/cli.ts health run --source eslint,typescript` | pass: 0 findings; optional sources skipped; partial coverage | `2026-11-02T13-07-05-805Z-e5b71b_run.log` |
| changed tests | `bun run src/cli.ts test run --changed --strict` | pass: 254 passed, 0 failed, 0 skipped; 43 selected files | `2026-11-02T13-07-39-584Z-8b78bb_run.log` |
| hub web | `bun run check:hub-web` | pass: 43 files, 217 passed, 0 failed; typecheck, lint and generated assets freshness passed | `2026-11-02T13-06-30-557Z-9ee5a6_run.log` |
| hub backend | `bun test src/hub/` | pass: 96 files, 555 passed, 0 failed | `2026-11-02T13-07-01-804Z-7ddc04_run.log` |
| packaging and cache | `bun test scripts/package-team-hub.test.ts scripts/hub-runtime-cache.security.test.ts` | pass: 14 passed, 0 failed, 1 skipped (offline runtime cache integration) | `2026-11-02T13-06-50-484Z-9c4e3a_run.log` |
| circular imports | `madge --circular --extensions ts,tsx src/` | skipped: madge unavailable; not a devDependency | — |

Raw logs are in `.metaproject/data/gdctx/raw/`; commands above ran via `bun run src/cli.ts ctx run --`.

## Limitations

- One packaging integration test skipped because the offline runtime cache was not prepared; no network or install attempted.
- Optional circular import check skipped because madge is unavailable.
- Health was limited to eslint and typescript; other sources intentionally skipped.
- Changed-test runner selects web .case files through Bun; the separate Vitest web suite is authoritative for those cases.

## Notes

- Commands were run through bun run src/cli.ts ctx run -- except availability discovery.
- Packaging run temporarily unlinked apps/hub-web/node_modules and restored the original symlink target in EXIT trap; root node_modules untouched.
- The parent committed the same working-tree bytes while verification ran.
- Web asset digest: 8a23202fa242a709b9a993138c2b42151738535f00c3e0c95ab86e3d76a830a3.

Routing audit: graph_used: yes (changed-test selection); wiki_used: no (not relevant to verification); ctx_used: yes; raw_rg_used: no.
