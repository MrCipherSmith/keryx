# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: An oxlint-only fixture (`.oxlintrc.json`, a fake `node_modules/.bin/oxlint`, no ESLint config) detects oxlint as available and parses one error into a finding whose source is `oxlint`, not `eslint`.
- AC2: An eslint-only fixture still detects and parses eslint findings with source `eslint`. A project with neither linter reports oxlint skipped and keeps the existing required-eslint incomplete behavior.
- AC3: When oxlint runs and parses, the gate does not report INCOMPLETE `required source unavailable: eslint` solely because eslint is skipped.
- AC4: A fixture with `tsconfig.json` and an executable `node_modules/.bin/tsc`, and with `tsc` absent from PATH, detects typescript as available and runs that local binary with `--noEmit --pretty false`.
- AC5: A missing eslint or typescript source whose config exists and whose binary does not carries a non-empty reason naming the binary and both lookup places (`node_modules/.bin` and PATH).
- AC6: Unparseable oxlint output is `configured-but-failed`, not an empty success. A non-zero `tsc` exit with recognized `TS*` errors is findings, not a missing source.
