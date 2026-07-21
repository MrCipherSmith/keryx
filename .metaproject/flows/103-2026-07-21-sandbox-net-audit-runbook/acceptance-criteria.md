# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: The allowlist proxy's per-host allow/deny decisions cross the worker boundary to the parent process, and `setupNetworkRun` exposes them to its caller; a unit test asserts both an allowed and a denied host arrive.
- AC2: `keryx harness exec` with a restricted network prints a compact network-decision summary (allowed and denied hosts with counts) after the run, and prints nothing extra when the network is not restricted.
- AC3: A Linux verification runbook exists in the repository, is self-contained (no reliance on this chat), and covers filesystem containment, network-off, the domain allowlist, credential masking, and the known Go-tool TLS limitation — each step with the exact command and the exact expected result.
- AC4: The runbook states explicitly, for every check, what a PASS looks like and what a FALSE PASS looks like (a result a broken sandbox could also produce), so a wrong environment cannot be mistaken for containment.
- AC5: `bun run typecheck` is clean and the full `bun test` suite passes with 0 failures.
