# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: On a Linux host without `bubblewrap`, installation states that OS containment is unavailable and names what provides it; the message is asserted by a test that does not require bubblewrap to be absent from the test machine.
- AC2: A CLI command reports launcher availability and the per-capability containment matrix for the current platform without running a contained command, and exits zero regardless of the result — it is a report, not a gate.
- AC3: The report distinguishes "launcher not installed" from "capability not implemented on this platform"; a test asserts both sentences exist and are not interchangeable.
- AC4: The capability matrix in the command output and the matrix in `docs/verification/linux-sandbox-verification.md` are generated from, or tested against, a single source, so they cannot drift.
- AC5: `KERYX_SANDBOX_SHELL` keeps its current default and no contained path stops failing closed; a test covers the failing-closed behaviour.
- AC6: The new command is registered in `src/standard/command-registry.ts` with its intents, so natural-language routing can reach it.
