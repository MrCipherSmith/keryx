# Review Fix Report

Version: 0.1.0
Date: 2026-07-07
Status: verified

## Scope

This report tracks fixes applied after the `REQUEST_CHANGES` review of `gd-metapro`.

## Fixed

- Package entrypoint: `package.json` now exposes `gd-metapro` from `dist/cli.js`, with `build`, `prepare`, and `prepack` scripts for GitHub/npm installation.
- Package contents: publishable `files` are `dist`, `src/gdgraph`, `src/gdskills/bundled`, `src/gdskills/contracts`, `README.md`, and `package.json` (the graph/skills source assets the runtime loads are shipped); raw `src/scripts` artifacts are not part of the runtime package surface.
- Version source: CLI version is read from `package.json` instead of a hardcoded constant.
- Health defaults: generated/static outputs are ignored by default, including `dist`, `build`, `coverage`, `.next`, `out`, `storybook-static`, `public`, and `generated`.
- Health/testing link: Code Health imports compatible Testing reports by scope/git ref instead of launching broad tests implicitly.
- Health I/O: source LOC and complexity are collected once through a shared parallel analysis pass and reused by complexity findings and scope metrics.
- Testing strictness: `gd-metapro test run --strict` and the pre-push hook can fail gates, while non-strict changed runs remain advisory.
- Hooks: duplicated post-commit/pre-push installers are consolidated into one managed hook writer with stable gd-metapro block markers.
- CLI option parsing: repeated option-value helpers are consolidated into `src/lib/args.ts`.
- Project-skill resolution: `skills export` and `skills verify` share one resolver in `src/gdskills/resolve.ts`.
- Path normalization: repeated `toPosix` helpers are consolidated in `src/lib/fs.ts`.
- JSON robustness: critical manifest/config/report reads now use safe helpers or local `try/catch` paths.
- Command side effects: health and memory services are lazily initialized inside command execution.
- Path safety: learning proposal application is constrained to project-local proposal files and `.metaproject/project-skills`; runtime skill sync rejects filesystem/home root targets and paths outside the project or user home.

## Verification Plan

- `bun run typecheck` - pass.
- `bun test` - pass, 59 tests (point-in-time snapshot as of the review commit; the suite has since grown).
- `bun run build` - pass, generated `dist/cli.js`.
- `bun dist/cli.js --version` - pass, prints `0.1.0`.
- `bun src/cli.ts test run --changed --since HEAD` - pass, selected 3 related test files.
- `bun src/cli.ts health run --changed --since HEAD` - warn, non-blocking regression against current baseline; testing source is imported from the Testing report.
- `bun src/cli.ts memory check` - pass.

## Remaining Follow-Up

- Split `src/commands/init.ts` into smaller module initializers after the public install/build fixes are stable.
- Add package-install smoke tests that run against the built `dist/cli.js`.
- Extend tests around corrupt JSON files and large frontend generated-artifact filtering.
