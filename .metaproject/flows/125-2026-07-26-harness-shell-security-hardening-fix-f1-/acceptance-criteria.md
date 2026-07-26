# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: F1 — an untrusted in-repo `.keryx/sandbox-policy.json` can no longer widen network egress or add credential inject-hosts: project-policy `allowedDomains` and `extraMasks` are ignored unless the trusted opt-in `KERYX_SANDBOX_TRUST_PROJECT_POLICY` is set; a `strict` (network-off) request stays network-off without the opt-in. Covered by tests for both the ignored-by-default and honoured-when-trusted paths.
- AC2: F3 — `shell_exec` (and any tool) output is passed through the security secret/PII redactor before it is appended to provider-bound history, so a `cat`/`env` of a secret reaches the model as `[REDACTED:…]`. Covered by a test asserting a planted secret in tool output is redacted in history.
- AC3: F2 — the OS-sandbox default read-deny list is broadened to the common secret locations (kube/docker/npm/cloud SDK caches, etc.) and is user-extensible via `KERYX_SANDBOX_READ_DENY`; documented as a write/network boundary. Covered by a test on the expanded list + env extension.
- AC4: F4/F5 — broad file-readers (`cat`, `grep`, `head`, `tail`, `less`, …) and destructive-capable mutators (`rm`, `rmdir`, `mv`, …) can no longer be stored as bare `<word> *` prefix grants (never auto-approved from a remembered prefix); a narrower pattern remains offerable. Covered by `validateShellPattern` tests.
- AC5: F6 — `delegate` (spawn_subagent) is fail-closed: with no approver present it is denied by default like `shell`, not silently invoked. Covered by an `executeCall` test.
- AC6: F7 — the dead secret-key stripping loop in `sanitizeProjectSandboxPolicy` is removed (whitelist construction already excludes unknown keys); behaviour unchanged, no dead code. Covered by existing sanitizer tests staying green.
- AC7: All gates pass — `tsc --noEmit` clean, the touched unit tests green, no regression in run/policy/sandbox/security suites; `keryx health run` gate = pass.
- AC8: A draft PR is opened for the branch with a description enumerating F1–F7, their fixes, and the residual (documented) items.
