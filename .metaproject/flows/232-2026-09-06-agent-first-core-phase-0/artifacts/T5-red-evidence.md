# T5 M01 RED evidence

- Timestamp: `2026-09-06T10:48:47Z`
- Git HEAD: `0bc6418fa1a038f8ec909cf949fecba077acf9a4`
- Test file SHA-256: `f4f5759f0e818def06ac5544f872bdd7a562f3c807b876ff62bca128b1be9145`
- Command: `bun test src/commands/routing-entrypoint-lifecycle.test.ts`
- Captured through: `keryx ctx run -- bun test src/commands/routing-entrypoint-lifecycle.test.ts`
- Exit code: `1`
- Result: `0 pass`, `3 fail`, `14 expect() calls`
- Duration reported by Bun: `239.00ms`

## Failure signatures

1. `init and repeated rules sync preserve the short gate, full router, flags, and user content`
   - Expected `index.md` length `< 2000`; received `4339` after `rules sync`.
   - This reproduces `rules sync` replacing the compact gate with the full router.
2. `distill and update repeats keep routing ownership and point orient and the router skill at the full document`
   - Expected compact `index.md` length `< 2000`; received `4579` after `rules distill`.
   - Later assertions also pin `routing.md` ownership, repeated update stability, orient routing resolution, catalogue workflow resolution, and preserved user content once the first defect is fixed.
3. `a failed routing pair publication is observable and succeeds on a clean rerun`
   - Expected a publication `Error`; received `undefined` while `routing.md` was an unwritable directory target.
   - This reproduces false success because the current rules path never attempts to publish `routing.md`.

## Captured raw output

The complete stdout/stderr capture for this exact run is retained at:

`.metaproject/data/gdctx/raw/2026-09-06T10-48-47-350Z_run.log`

The compact command report is retained at:

`.metaproject/data/gdctx/artifacts/2026-09-06T10-48-47-350Z_run.md`

## Syntax/type validation

- Command: `bun run typecheck`
- Exit code: `0`
- Complete capture: `.metaproject/data/gdctx/raw/2026-09-06T10-49-12-402Z_run.log`
