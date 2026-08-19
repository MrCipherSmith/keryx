# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: With a main agent turn in progress (`chrome.isBusy()` true) and at
  least one `output`-kind block registered, typing `/expand` toggles the
  newest output block's collapsed state and does NOT show the "main is busy —
  command deferred" message.
- AC2: With a main turn in progress and at least one `thought`-kind block
  registered, typing `/think` toggles the newest thought block's collapsed
  state, with the same "deferred" non-message guarantee as AC1.
- AC3: With a main turn in progress and at least one block registered, typing
  `/copy` copies the newest block's full text to the clipboard, with the same
  "deferred" non-message guarantee as AC1.
- AC4: With a main turn in progress, typing `/workspace` opens the workspace
  inspector modal (same modal the idle path opens), with the same "deferred"
  non-message guarantee as AC1.
- AC5: With a main turn in progress, typing `/review` opens the review
  inspector modal (same modal the idle path opens), with the same "deferred"
  non-message guarantee as AC1.
- AC6: With a main turn in progress, typing `/model` (a representative
  out-of-scope command) still shows the "main is busy — command deferred"
  message unchanged, and no model-selection state changes.
- AC7: With no main turn in progress (idle), `/expand`, `/think`, `/copy`,
  `/workspace`, and `/review` each behave exactly as they did before this
  change (no regression to the idle path).
- AC8: The full existing test suite (`tsc --noEmit` and `bun test`) passes
  after the change, with no test file modified except the addition described
  in AC9/AC10 (see 2026-08-19 addendum: the original "zero new test files"
  wording is superseded by the operator's explicit test-coverage request).
- AC9: `src/tui/busy-dispatch.ts` exports a pure `classifyBusyDispatch`
  function (no `@opentui/core`/renderer/chrome dependency) whose returned
  decision for every one of the 11 named commands, `/model` (deferred), and
  a non-slash line (not-a-command) matches `runLine`'s actual busy-branch
  behavior for that same input.
- AC10: `src/tui/busy-dispatch.test.ts` unit-tests all 13 cases from AC9
  directly against `classifyBusyDispatch`, without mounting any renderer —
  the suite runs and passes as part of `bun test`.
