# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: With a main agent turn in progress (`chrome.isBusy()` true), typing
  `/mode auto` (and confirming the overlay) changes the permission mode,
  taking effect on the running turn's next not-yet-gated tool call — no
  "main is busy — command deferred" message is shown.
- AC2: With a main turn in progress, typing `/mode trust` or `/mode ask`
  changes the permission mode without a confirmation overlay (matching
  idle-path behavior), no deferred message.
- AC3: With a main turn in progress, typing `/mode clear` clears the
  project default permission mode, no deferred message.
- AC4: With a main turn in progress, typing `/mode` with no argument opens
  the permission-mode picker overlay; selecting a mode applies it the same
  way the idle path does.
- AC5: With a main turn in progress, typing `/mode auto` shows the
  one-time confirmation overlay and does NOT change the mode until
  confirmed — cancelling leaves the mode unchanged.
- AC6: With a main turn in progress, typing `/model` (a real, similarly-
  named, out-of-scope command) still shows the "main is busy — command
  deferred" message unchanged — guards against a `/mode`/`/model` name
  confusion bug.
- AC7: `/mode`'s idle-path behavior (all forms: explicit mode, `clear`,
  no-arg picker) is unchanged after the extraction into `runModeCommand`.
- AC8: `classifyBusyDispatch` has a new test case asserting `/mode` resolves
  to `"mode"`.
- AC9: The full existing test suite (`tsc --noEmit` and `bun test`) passes.
