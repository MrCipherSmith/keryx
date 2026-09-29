# Health runs the project's real linter and tsc

## Problem

`keryx health run --strict` treats ESLint and a PATH-visible `tsc` as the only way a project can be linted and type-checked. On vantage-frontend (pnpm, TypeScript 7.0.2, oxlint 1.81.0) both required sources came back not-run:

- eslint: skipped, because there is no ESLint config and no `node_modules/.bin/eslint`
- typescript: missing, even though `tsconfig.json` and `node_modules/.bin/tsc` exist and `tsc --version` prints `Version 7.0.2`
- gate: INCOMPLETE, `required source unavailable: eslint` and `required source unavailable: typescript`

The lint script is `oxlint --type-aware ...`. Health has no oxlint adapter. `missingSourceReason` names a cause only for `tests`, so eslint and typescript report a bare `missing`.

## Expected outcome

Health runs the linter and the TypeScript compiler the project actually has.

- An oxlint project reports source `oxlint`, never relabeled as `eslint`.
- Required lint is satisfied when at least one detected linter (eslint or oxlint) runs and parses. A project with no linter keeps today's required-eslint incomplete.
- TypeScript is available when `tsconfig.json` and an executable `node_modules/.bin/tsc` exist, even if `Bun.which("tsc")` is null.
- A missing source names what was looked for and where it was not found.

## Out of scope

- Fixing vantage-frontend.
- Scanning or executing arbitrary `package.json` scripts.
- SonarQube and coverage.
- Weakening the gate so a missing required source becomes a pass.
