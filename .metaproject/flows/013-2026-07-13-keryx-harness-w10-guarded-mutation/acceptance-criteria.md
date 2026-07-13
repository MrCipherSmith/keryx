# Acceptance Criteria

Rules:

- Criteria lines use the exact format `- ACn: <criterion>`.
- After `flow freeze` this file is checksum-protected: any edit outside
  `keryx flow ac update` fails every gate and status transition.
- Completion requires every ACn to be confirmed via
  `keryx flow ac confirm <id> <ACn>`.

## Criteria

- AC1: M-01 fingerprint + approval — `src/harness/mutation/` produces a canonical, deterministic action-fingerprint over `{path, argv, env}`; `approval-request` and `approval-result` validate against their schemas via `src/contracts`; an approval is single-use (consumed once, not reusable), is invalidated when the action-fingerprint changes (stale), and a denied / expired / headless (interactive:false + ask) approval NEVER authorizes execution (fail-closed).
- AC2: M-01 path/argv/env rules — path traversal and symlink escape outside the approved worktree root are rejected (deny); shell injection in argv is rejected; a redirect / private-address egress is rejected; direct credential access is rejected; a read within the approved root is allowed (SC_R15_READ_WITHIN_ROOT / PATH_TRAVERSAL_DENIED / SYMLINK_ESCAPE_DENIED / SHELL_INJECTION_DENIED / REDIRECT_PRIVATE_ADDRESS_DENIED / CREDENTIAL_REQUEST_DENIED).
- AC3: M-01 fail-closed scan-state — when a required scan or isolation control is unavailable, the decision is deny (never a silent allow); SC_R15_FAIL_CLOSED_ISOLATION.
- AC4: M-02 guarded mutation + reconcile — under a `trusted-local` profile with a valid single-use approval, a mutation is monitored and executed through a fake mutation adapter and an `execution-receipt` plus evidence is persisted (valid against `execution-receipt.schema.json`); SC_R04_GUARDED_MUTATION. An `unattended-untrusted` mutation stays BLOCKED without an isolation boundary. An unknown side effect requires reconciliation (reusing the W8 `recoverFrom`; an outcome-unknown blocks an unsafe retry). NO real filesystem mutation occurs.
- AC5: No regression / reuse / determinism / scope — `tsc --noEmit` is clean and the full `bun test` suite is ≥ the pre-change baseline of 844 pass with the new tests green and 0 fail; the W3 policy engine, W8 recovery, W5 ports, W6 fakes, and `src/contracts` validator are REUSED/COMPOSED (not rewritten); all behavior is deterministic (clock/id/adapter injected; no `Date.now`/`Math.random`/network/real-fs); no new production dependency (`dependencies` `{}`), no provider SDK; all new code lives under `src/harness/`; the frozen requirements package, `src/eval/`, `src/contracts/`, and ADR-0001…0004 are NOT modified.
