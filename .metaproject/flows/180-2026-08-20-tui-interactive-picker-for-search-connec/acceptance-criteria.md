# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: In the TUI, typing `/search-connect` with no arguments and at least one connected provider opens a single-step overlay picker (`SelectRenderable`) listing exactly `searchProviderController.selectable()`.
- AC2: Selecting a provider in the picker calls `controller.select(id)` — the same call the args-given path already makes — and shows the existing success/failure messages; Esc cancels the picker with no `select()` call made.
- AC3: If `selectable()` is empty, no picker opens; the existing "No connected search providers found. Run /search-provider first." message is shown (mirrors `/connect`'s empty-state handling).
- AC4: `/search-connect <id>` (args given) is unchanged — existing behavior and messages preserved exactly.
- AC5: `/search-provider` (flow 179's wizard) and its bare/args-given branches are untouched by this flow.
- AC6: Automated tests cover: bare-command picker trigger with 1+ connected providers, Esc-cancel with no `select()` call, successful selection, empty-`selectable()` no-picker path, and the unchanged args-given path. `bun test` passes.
- AC7: No changes to `src/commands/shell.ts`, `SearchProviderController`'s public API, or the flow-179 wizard functions (`searchProviderWizardInTui` and its step helpers).
- AC8: `keryx health run` gate passes (lint, type-check, tests) before flow completion.
