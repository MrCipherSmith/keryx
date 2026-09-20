# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `mcp-servers/invariants.test.ts` scans every non-test production file under `src/commands/` and `src/mcp-servers/` for `process.once` teardown handlers instead of a hardcoded two-file list, and keeps a non-vacuity check so the ban cannot pass by scanning nothing.
- AC2: The violation that scan found is fixed: `src/commands/serve.ts` registers its SIGINT/SIGTERM teardown with `process.on`, not `process.once`, so a second signal mid-drain reaches the existing idempotent `draining` guard instead of Node's default disposition. This is a deliberate behaviour change and is stated as one.
- AC3: Every other production edit in this flow is behaviour-neutral — an `export`, an optional injected dependency whose default reproduces the previous behaviour, or code moved unchanged behind a new function; each verified by reading the diff, not by trusting a report.
- AC4: `BUS_WAKE_CAPPED_NOTICE` is exported from `bus-wake.ts` and used by `tui-shell.ts`, and its audit is a constant comparison that no longer reads `tui-shell.ts` at all.
- AC5: `src/tui/bus-join.ts` exports `decideJoinAdoption` and `buildBusJoinCallbacks`, and every dependency of the latter is a getter rather than a captured value, because the controllers it reads are assigned long after the callbacks are built.
- AC6: `createSplashLifecycle` (`boot-animation.ts`) and `isToolAvailableToSideWorker` (`tui-shell.ts`) are extracted and their audits call them directly.
- AC7: `rememberExactShellGrant` accepts an optional `dir` that is a pass-through to the parameter `allowShellPattern` already took, so `src/lib/` is unmodified and the default still writes the operator's real permissions file.
- AC8: The manifest is regenerated from the live scan and shows 12 test files and 34 read sites, down from 13 and 42 at the start of this flow.
- AC9: Anything the inventory got wrong is corrected in place with the reason, including its claim that `decideJoinAdoption` unlocked four tests when it unlocks one.
- AC10: Audits left unconverted are still recorded with the seam each waits on, and `approval-wiring.test.ts` is named as needing a single owner across both god-files rather than parallel agents.
- AC11: typecheck, lint and the full test suite are green in CI on the PR head.
