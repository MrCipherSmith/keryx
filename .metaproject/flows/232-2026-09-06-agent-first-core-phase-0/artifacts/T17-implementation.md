# Required ESLint prerequisite

Added ESLint, the official JavaScript recommended rules, and typescript-eslint as development dependencies with a flat configuration for src/scripts TypeScript. Package lint runs eslint .; check now requires lint before both TypeScript projects and tests. Required health policy remains required.

Underscore-prefixed intentional unused parameters are allowed. Test-only rules permit adversarial any fixtures, empty provider generators, and environment-isolated require calls. Production rules are not globally disabled. T18 resolved its bounded 90-file legacy inventory. Root removed the remaining unused bindings/imports and redundant initial assignments in separately owned files.

One existing agent budget test declared alwaysFails but never supplied it to runAgentTurn. Root wired the declared tool and asserts exactly two real failures before the attempt limit, so the test now measures its stated behavior.

## Validation

- bun run lint: PASS, raw 2026-09-06T12-09-32-867Z_run.log.
- bun run typecheck: PASS, raw 2026-09-06T12-10-53-194Z_run.log.
- bun run typecheck:scripts: PASS, raw 2026-09-06T12-06-59-720Z_run.log.
- Root affected agent/hooks tests: 128 pass, 0 fail, 476 assertions, raw 2026-09-06T12-09-15-274Z_run.log.
- Dependency prepare build succeeded at installation; final integrated build remains part of T9.

These are current prerequisite/scoped results, not a whole-program PASS. Other phase workers add RED tests and are independently reviewed. No production dependency versions were intentionally changed and no publication occurred.
