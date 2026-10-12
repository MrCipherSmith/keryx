# Plan

## Approach

Add an oxlint source adapter beside eslint. Do not relabel oxlint findings as eslint. Satisfy required lint as a family: if any detected linter ran and parsed, a skipped sibling linter is not an INCOMPLETE required source. If no linter is configured, required eslint stays incomplete.

For TypeScript, reproduce the vantage report before changing detect. `resolveBin` already prefers `node_modules/.bin/tsc` over `Bun.which`. The missing report means some other branch is firing. Pin that branch with a test, then fix that branch. Do not guess.

## Trade-off

Required stays a per-source flag in config. The family exception lives in the gate, not in a second required flag that an old `health.config.json` would not have. oxlint defaults to not required on its own; it counts toward the lint family only when it actually produced a result.

## Out of this plan

No package.json script execution. No `pnpm type-check` override. No sonar or coverage changes.
