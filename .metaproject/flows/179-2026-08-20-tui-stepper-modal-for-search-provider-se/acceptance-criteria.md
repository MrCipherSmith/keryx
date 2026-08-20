# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: In the TUI, typing `/search-provider` with no arguments opens a 3-step overlay modal (provider select → fields/credential/active-toggle → test result), implemented in `src/tui/tui-shell.ts`.
- AC2: `/search-provider <id> [field=value...] [key=...]` (non-empty args) behaves exactly as before this change — existing tests covering that path still pass unmodified.
- AC3: `/search-connect` behavior and implementation are unchanged by this flow — it still just switches the active provider among already-connected ones (`SearchProviderController.select`).
- AC4: Step 1 lists exactly `searchProviderController.configurable()`; Esc at step 1 cancels the wizard with no config/credential/active-provider state mutated.
- AC5: Step 2 renders exactly `descriptor.fields` as inputs seeded with `defaultValue`, plus a credential prompt only when the provider's `credentialSchema` applies, plus a Yes/No "set as active" choice. A provider with 0 fields (any of the 3 remote providers) skips straight to the credential/toggle sub-step. Esc at any field/sub-step goes back one step, never silently closes the modal.
- AC6: Step 3 calls `configure()` then `test()`. On success it shows the pass state and, only if "set active" was Yes, additionally calls `select()` (the same call `/search-connect` makes) and confirms both actions. On failure it shows the failure reason and Esc returns to step 2 to retry, without closing the modal.
- AC7: Automated tests cover: bare-command wizard trigger, 0-field vs multi-field provider variance, Esc-back navigation at each step, success path with both toggle states, and the failure/retry path. `bun test` passes.
- AC8: No changes to `src/commands/shell.ts`, `SandboxedWebTransport`, `web-policy.ts`, or `SearchProviderController`'s public API — the wizard only calls its existing `configure`/`test`/`select` methods.
- AC9: `keryx health run` gate passes (lint, type-check, tests) before flow completion.
