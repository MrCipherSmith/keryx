# Implementation Plan

Status: ready for freeze

## Approach

Use one shared filesystem/Git snapshot helper plus a committed P0 authority
fixture, then add focused Bun tests at each boundary. Purity assertions run in
two modes: default characterization asserts and records the known legacy write,
while `KERYX_P0_ENFORCE=1` asserts the target no-write contract and fails with
the exact diff until P1 removes the side effect. This keeps the ordinary suite
green while making the desired contract executable and reviewable.

## Steps

1. Record the targeted baseline and preserve it in the flow context.
2. Add `snapshotProject()` with relative paths, SHA-256/content, and filtered
   Git status; add accepted/draft/conflict/deprecated/expired/superseded and
   Valid-To boundary fixtures.
3. Add service and CLI purity/legacy report-path characterizations.
4. Add native adapter, unified operation, MCP, and approval-context purity
   tests; preserve `risk: "read"` and `mutating: false` assertions.
5. Add flow-context authority/temporal tests and init/update/embedding baseline
   coverage or traceability where existing suites already prove the behavior.
6. Run focused verification, then update only P0 progress documentation and
   leave flow 105 in-progress for verified handoff.

## Risks

- The existing service result includes report paths; P0 must document rather
  than remove them.
- Test isolation must avoid mutating the shared dirty repository; fixtures run in
  temporary roots and snapshot helper excludes ignored runtime noise.
- Bun's default test runner must remain green; opt-in enforcement is not part of
  the default command.
