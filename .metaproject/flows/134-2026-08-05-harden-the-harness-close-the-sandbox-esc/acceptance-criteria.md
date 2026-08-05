# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: On Linux, a sandbox profile with `network: "restricted"` fails closed even with `KERYX_SANDBOX_ALLOW_UNSANDBOXED=1` set — the command is never spawned uncontained. A test asserts the `spawn-error`/`blocked` outcome with that variable set.
- AC2: The missing-launcher escape hatch still works: with `KERYX_SANDBOX_ALLOW_UNSANDBOXED=1` and no launcher available, a non-restricted profile still spawns. A test asserts both halves so AC1 cannot be satisfied by blanket-refusing everything.
- AC3: `scanAvailable` at the harness production call site is derived from whether the security scanner is actually reachable, not hardcoded. A test asserts that a run with the scanner absent is denied rather than allowed.
- AC4: The security scanner runs on the harness mutation path — a command whose recorded output carries a secret is scanned by the same seam memory/wiki/ctx use, with the finding surfaced. A test covers one positive detection.
- AC5: `runOffline` accepts flow-supplied `requiredEvidenceRefs` and `requiredGates` instead of hardcoded empty arrays, and a run missing a required evidence ref fails the completion gate. A test asserts one failing and one passing case.
- AC6: Branching is reachable from the CLI without editing session files by hand, and a forked branch appears in the session store with its ancestry intact. A test covers the command path.
- AC7: Replay-fixture validation is reachable from the CLI: a fixture built from a recorded run validates, and a tampered fixture reports a typed mismatch naming the diverging field. A test covers both.
- AC8: `bun run check` passes — typecheck plus the full suite, with no test skipped or weakened to accommodate these changes.
- AC9: No documentation claim is widened by this work. Any README or docs sentence that becomes true again is restored deliberately and named in the PR; nothing is claimed that a test does not cover.
