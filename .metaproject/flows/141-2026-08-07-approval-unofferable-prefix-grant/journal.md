# Flow Journal

- 2026-08-07T09:10:10.557Z - flow created
- 2026-08-07T09:11:48.245Z - task-added: T5: Failing tests for the frozen criteria
- 2026-08-07T09:11:48.334Z - task-added: T6: Implement the fix
- 2026-08-07T09:11:48.424Z - task-added: T7: Verify: focused tests + keryx health run
- 2026-08-07T09:11:49.137Z - frozen: 5 criteria; checksum recorded
- 2026-08-07T09:11:49.223Z - started
- 2026-08-07T09:21:00.000Z - task-implementer: T5/T6/T7 done. Fix: `suggestShellPatterns` in
  `src/lib/shell-permissions.ts` now gates `offerPrefix` on
  `validateShellPattern(prefix).ok && isShellCommandAllowed(trimmed, [prefix])` instead of
  `!destructive && validateShellPattern(prefix).ok`. `isShellCommandAllowed` is the exact
  predicate a stored grant is later run through (metacharacter/destructive/credential
  barriers, then pattern match against the command), so this both closes the C3
  metacharacter gap (AC1) and an isomorphic gap the same asymmetry left open for
  credential-touching commands (e.g. `chmod 600 permissions.json` offered `chmod *`
  before the fix). `offerExact` untouched — root cause note confirms it was already
  correct since `exact` IS the command. Tests added to
  `src/lib/shell-permissions-hardening.test.ts` (AC1-AC4, ~113 lines): C3 command
  regression, clean-command-still-offered regression, a property-style loop of ~20
  commands asserting "offer implies isShellCommandAllowed would auto-approve this
  command" (deliberately single-spaced/single-line — the pre-existing exact-offer
  whitespace-collapse behavior is untouched, out of scope), and a destructive +
  credential-touching "offers neither" check. AC5: `tui-shell.ts:438` comment
  needed no edit — it was already an accurate description of intended behavior;
  the fix makes the code beneath it match it. Verify: focused bun test
  (shell-permissions.test.ts + shell-permissions-hardening.test.ts) = 58 pass, 0
  fail. `keryx health run` = FAIL, but the 3 P0 findings are TS errors in
  `src/commands/sandbox.ts` / `sandbox.test.ts` — untracked files from an unrelated
  flow (sandbox-launcher-visibility), not touched by this task; `git status`
  confirms only `src/lib/shell-permissions.ts` and
  `src/lib/shell-permissions-hardening.test.ts` were modified.
- 2026-08-07T09:22:04.756Z - task-done: T1: Collect remaining context
- 2026-08-07T09:22:04.850Z - task-done: T2: Implement per plan
- 2026-08-07T09:22:04.943Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-07T09:22:05.030Z - task-done: T5: Failing tests for the frozen criteria
- 2026-08-07T09:22:05.118Z - task-done: T6: Implement the fix

## Orchestrator note — 2026-08-07, worker returned DONE_WITH_CONCERNS

The concern is real and it is **not** this flow's. The worker reported
`keryx health run` FAIL with 3 P0 TypeScript errors in `src/commands/sandbox.ts`
and its test. Verified independently: `git status --short` shows both files
untracked, authored by flow 142, which was still mid-flight when 141 finished.
141's own diff is two files.

Cause is an orchestration choice, not a defect: three flows run in one working
tree with disjoint FILE scopes, but `keryx health run` is repo-wide, so each
worker's gate sees the others' in-flight work. Disjoint edits do not give
disjoint gates.

Consequence: T7 (verify) stays open for 141 until 140 and 142 land, then the
gate runs once over the whole set. T4 stays open pending the completion choice.

Change accepted on review: `offerPrefix` now asks `isShellCommandAllowed`, the
same predicate a stored grant is run through later. `!destructive` was dropped
and correctly so — `isShellCommandAllowed` performs that check itself.
`validateShellPattern(prefix)` is rightly kept: it guards whether the PATTERN is
safe to store (bare interpreter grants, banned prefix mutators), which the
command-side check does not cover.

Side effect worth recording: the credential-touching case for `offerPrefix` was
broken the same way and is fixed by the same line, not by extra scope.
- 2026-08-07T09:35:49.209Z - task-done: T7: Verify: focused tests + keryx health run
- 2026-08-07T09:35:49.297Z - task-done: T4: Self-review and prepare draft PR
