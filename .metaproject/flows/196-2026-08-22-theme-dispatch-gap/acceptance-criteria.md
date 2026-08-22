# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: Typing `/theme` in agent-mode readline no longer returns "Unknown command" — it either dispatches to a working readline-mode handler, or is removed from the `/help`-advertised list, per the chosen direction.
- AC2: `/help`'s advertised command list and the actual agent-mode dispatch chain are consistent for `/theme` — no self-contradiction between what's advertised and what's runnable.
- AC3: A regression test (or, if a unit test isn't practical for the readline REPL, a documented manual verification transcript) covers the chosen behavior.
- AC4: `tsc --noEmit` is clean and existing shell/readline tests pass with no regressions.
