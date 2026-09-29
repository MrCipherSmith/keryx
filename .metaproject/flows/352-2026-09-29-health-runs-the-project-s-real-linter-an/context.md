# Context

Verified against `src/health` on main (`d5b9fb11`), not against the installed 0.3.36 bundle.

- `src/health/sources/eslint.ts`: skipped without an ESLint config file; otherwise available only if `resolveBin(cwd, "eslint")`. Run is always `eslint . --format json`.
- `src/health/sources/typescript.ts`: skipped without `tsconfig.json`; otherwise available only if `resolveBin(cwd, "tsc")`. Run is `tsc --noEmit --pretty false`.
- `src/health/sources/helpers.ts` `resolveBin`: `node_modules/.bin/<name>` if it exists, else `Bun.which`. A local binary should already win over a null PATH lookup. The vantage `missing` report is therefore not explained by this function alone and must be reproduced.
- `src/health/run.ts` `missingSourceReason`: a reason only for source `tests`. eslint and typescript missing lines stay bare.
- `src/health/gate.ts`: a required source whose status is not available, or whose execution/parse is not-run, escalates to INCOMPLETE.
- `src/health/config.ts`: eslint and typescript are `required: true`. There is no oxlint source. `SourceId` in `src/health/types.ts` has no `oxlint` member.
- oxlint is mentioned only as a directive marker (`src/review/floor.ts`) and a memory-search fixture. No health adapter exists.

User report, not re-run here: vantage-frontend, pnpm, TypeScript 7.0.2, oxlint 1.81.0, lint script `oxlint --type-aware ...`, `.oxlintrc.json`, no eslint config, local `tsc` prints `Version 7.0.2`, `Bun.which("tsc")` returned null, health said both required sources unavailable.
