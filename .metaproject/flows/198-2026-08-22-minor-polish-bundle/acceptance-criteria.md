# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The auto-approval line for a destructive `shell_exec` call includes a `[destructive]` marker in every permission mode (`ask`/`trust`/`auto`), verified by a test.
- AC2: A non-TTY `keryx shell` process exits promptly on `SIGINT`, verified by a test/script that sends SIGINT to a piped process and asserts timely exit.
- AC3: `docs/verification/keryx-shell-tui-test-catalog.md`'s SESSCLI-04 row is updated to describe the actual graceful-recovery expected behavior instead of a named refusal.
- AC4: `tsc --noEmit` is clean and existing tests pass with no regressions.
