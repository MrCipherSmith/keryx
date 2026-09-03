# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Normal agent turns and in-process wiki enrichment register in one identity-safe foreground-operation lifecycle with at most one active operation.
- AC2: `/interrupt` cancels wiki planning/enrichment, prevents new page work and post-abort persistence, and returns the TUI to a usable non-busy state.
- AC3: Queue Force cancels the active foreground operation, waits for settlement, then executes the selected item exactly once before remaining FIFO items.
- AC4: Busy `/exit` and renderer teardown cancel foreground work and prevent later queue drain, repaint, or UI callbacks after disposal.
- AC5: The same `AbortSignal` reaches wiki legacy/light model turns and `ProviderPort.stream`; deep enrichment composes external cancellation with its existing timeout without treating user cancellation as timeout success/fallback.
- AC6: Abort-aware page scheduling preserves successfully committed pages, never marks an unwritten page complete, and exposes deterministic cancellation accounting for untouched/in-flight pages.
- AC7: Explicit `keryx wiki enrich` options are preserved rather than replaced by natural-language-router defaults, while natural-language enrichment still uses its confirmation picker.
- AC8: Deterministic regression tests cover provider signal propagation, pool scheduling/persistence fences, light/deep wiki cancellation, TUI interrupt/Force/exit lifecycle, and explicit command routing.
- AC9: Focused tests, full type-check/test suite, strict Code Health, and the managed review loop pass with no blocker, major, or minor findings before merge.
- AC10: A PR from `fix/tui-foreground-operation-cancellation` is reviewed, merged into recorded base branch `main`, pushed to origin, and flow 219 is completed with acceptance evidence.
