# Fix plan: keryx shell review 2026-08-16

Validated against `origin/main` (`b8730a5` / 0.2.37). This branch implements
the confirmed P1/P2-S/P3 items. Monolith splits (`shell.ts`, `tui-shell.ts`)
stay out of scope — they are large, independent refactors.

## In scope

| # | From review | Change |
|---|-------------|--------|
| 1 | P1 tool parity | `buildInteractiveAgentTools()` used by TUI `makeAgentDeps` and readline `agentDeps`. Parity test on tool names. |
| 2 | P1/P2 approval + P3 hints | `evaluateShellApproval()` shared by TUI and readline: disk allowlist, migration/tamper, no auto-approve when destructive or credentials. Readline prompt shows those flags and accepts `A` = remember exact when offerable. |
| 3 | P2 G-2 flake | `git init -b` in the otui test; unit-test `resolveSidebarMetadata` with an injected git runner. |
| 4 | P3 chat estimate | One line in chat `/help`: context counter is an estimate. |

## Out of scope

- Splitting `shell.ts` / `tui-shell.ts` / `transcript-blocks.ts`
- Full readline “always-prefix” dock (exact remember is enough for parity)

## Done when

- `bun test` on the new units + `shell.test.ts` + `tui-shell.test.ts` + permissions
- TUI and readline tool name sets are identical
- Draft PR review is clean, then merge
