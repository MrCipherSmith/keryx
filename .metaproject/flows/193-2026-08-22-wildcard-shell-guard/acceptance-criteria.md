# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: `validateShellPattern` rejects a bare `keryx *` pattern the same way it already rejects other destructive-verb wildcards, verified by a new or updated unit test.
- AC2: The harness's own binary name is resolved dynamically (e.g. from the package name or `process.argv0`), not hardcoded as a literal string.
- AC3: The permissions load-time audit path (`loadShellPermissionsWithAudit` or equivalent) flags any pre-existing bare single-word wildcard already present in a loaded `permissions.json`, before the first auto-approve of a session, consistent with how `rejected`/`tampered` patterns are already surfaced.
- AC4: `tsc --noEmit` is clean and the full relevant test suite (shell-permissions tests at minimum) passes with no regressions.
