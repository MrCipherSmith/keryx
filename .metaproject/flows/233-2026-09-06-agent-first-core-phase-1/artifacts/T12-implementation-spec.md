# T12 Implementation Specification

## Objective

Make health gates truthful when required evidence is absent or unreadable. A report may still contain blocking findings while independently recording incomplete source coverage.

## Files and ownership

- `src/health/types.ts`: add the `incomplete` gate state, explicit coverage state, and additive source execution/parse evidence.
- `src/health/gate.ts`: fold blocking findings, required-source completeness, warnings, and pass in deterministic priority order.
- `src/health/run.ts`: retain required sources excluded by a filter, classify tool execution separately from parse validity, and preserve recognized findings from nonzero tool exits.
- `src/health/sources/*`: recognize supported dependency-audit and ESLint payloads without treating malformed or unknown JSON as an empty successful result.
- `src/health/service.ts`, `src/commands/health.ts`, `src/health/report.ts`: make stored and live CLI exit behavior and rendering agree with gate status and strict warning policy.
- Existing T11 health tests: keep the eight demonstrated RED cases and add bounded edge cases for supported empty audits, invalid/unknown JSON, crashes, recognized nonzero findings, filters, and strict warning parity.

No package, lockfile, flow state, frozen acceptance criteria, git state, routing, or unrelated production files will be changed.

## Behavioral contract

1. Blocking findings and configured regression thresholds produce `fail`.
2. If no blocking condition exists, any required source that is missing, skipped, disabled, filtered, execution-failed, or parse-failed produces `incomplete`.
3. `coverage` is independent from severity status: a report can be `fail` with `coverage: incomplete`.
4. Optional skipped sources remain visible in reasons but do not make coverage incomplete. Existing optional failure and regression warnings remain warnings.
5. A nonzero tool exit with recognized findings is a completed evidence run. A nonzero exit without recognized findings is an execution failure.
6. Invalid JSON or an unsupported JSON shape is a parse failure even when the process exits zero. Supported empty audit shapes are valid and produce zero findings.
7. Live and stored health commands always exit nonzero for `fail` and `incomplete`; strict warning mode also exits nonzero for `warn`.

## Verification

- Focused RED/GREEN suite: `bun test src/health/health-truthful-gate.test.ts src/health/dependency-audit-format.test.ts src/commands/health-incomplete.test.ts`
- Existing focused health tests covering changed modules.
- `bun run typecheck`.
- Result contract validation through the source CLI and security scan of the final T12 result artifact.

