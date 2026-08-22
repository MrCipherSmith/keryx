# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `keryx workspace catch-up` lists a closed, unbound external MCP slate under "Unbound candidates" (or an equivalent clearly-labeled section), matching the shape already used for internal sessions.
- AC2: An integration-style test reproduces the original repro (open+seed+close an external slate with no `workspaceId` bound, via the MCP surface) and asserts it now surfaces in `catch-up`'s output.
- AC3: A bound (already associated with a workspace) external slate is NOT incorrectly reported as an unbound candidate — no false positives.
- AC4: `tsc --noEmit` is clean and existing catch-up/SAC tests pass with no regressions.
